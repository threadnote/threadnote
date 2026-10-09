import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, PlatformError} from 'effect';
import {afterEach, describe, expect, it} from 'vitest';
import {
  codeGraphLifecycleDiagnosticIssue,
  inspectAllCodeGraphs,
  inspectAllCodeGraphsLocal,
  renderCodeGraphDiagnostics,
  type CodeGraphLocalDiagnosticsReport,
} from '@threadnote/graph/diagnostics';
import {runCodeGraphDiagnostics} from '@threadnote/threadnote/code_graph/commands';
import {deepDiagnosticsWorkerEnvironment} from '@threadnote/graph/deep_diagnostics';
import {CodeGraphStore} from '@threadnote/graph/store';
import {recordVerifiedCodeGraphLocalAssociation} from '@threadnote/graph/local_provenance';
import {observeManagerGraphCatalogRevision} from '@threadnote/graph/manager/catalog_revision';
import {resolveRepositoryIdentity} from '@threadnote/graph/repository';
import {
  managerGraphBuildCatalog,
  managerGraphCatalog,
  releaseManagerGraphSnapshotLeases,
} from '@threadnote/graph/visualization';
import {CODE_GRAPH_SCHEMA_VERSION, type CodeGraphSnapshot, type RepositoryIdentity} from '@threadnote/graph/types';
import {captureConsole} from '@threadnote/threadnote/effect/console';
import {CommandExecutor} from '@threadnote/platform/command';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {join, mkdir, mkdtemp, rm, writeFile} from '../helpers/effect-filesystem.js';

describe('all-code-graph diagnostics', () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map(home => rm(home, {force: true, recursive: true})));
  });

  it('passes only bounded bootstrap variables and the exact Threadnote home to the deep worker', () => {
    expect(
      deepDiagnosticsWorkerEnvironment(
        {
          ARBITRARY_PARENT_VALUE: 'private',
          HOME: '/bootstrap-home',
          PATH: '/bootstrap-bin',
          THREADNOTE_TEST_SECRET: 'private-secret',
        },
        '/threadnote-home',
      ),
    ).toEqual({
      HOME: '/bootstrap-home',
      PATH: '/bootstrap-bin',
      THREADNOTE_CODE_GRAPH_DEEP_DIAGNOSTICS_WORKER: '1',
      THREADNOTE_HOME: '/threadnote-home',
    });
  });

  it('projects cursor recovery as one fixed path-free diagnostics issue', () => {
    const privateMarker = '/private/repository/malformed-cursor-value';
    const lifecycle = {
      checkoutId: 'a'.repeat(64),
      opportunity: 'diagnostics',
      result: {
        cleanup: 'none',
        diagnostics: ['orphan-provenance-cursor-recovered'],
        expiredLeases: 0,
        privateMarker,
        remaining: false,
        retiredSnapshots: 0,
        rowsDeleted: 0,
        state: 'completed',
      },
      state: 'completed',
    } as const;
    const issue = codeGraphLifecycleDiagnosticIssue(lifecycle);

    expect(issue).toEqual({
      code: 'orphan-provenance-cursor-recovered',
      message: 'Recovered an invalid orphan provenance cleanup cursor; bounded rotation restarted.',
    });
    expect(JSON.stringify(issue)).not.toContain(privateMarker);
    expect(codeGraphLifecycleDiagnosticIssue({opportunity: 'diagnostics', state: 'no-target'})).toBeUndefined();
  });

  effectIt.effect('reports every database without a repository cwd and keeps JSON privacy-safe', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-diagnostics-'));
      homes.push(home);
      const healthyCheckoutId = '1'.repeat(64);
      const unreadableCheckoutId = '2'.repeat(64);
      const healthyRoot = join(home, 'indexes', 'code-graph', 'repositories', healthyCheckoutId);
      const healthyDatabase = join(healthyRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      const unreadableRoot = join(home, 'indexes', 'code-graph', 'repositories', unreadableCheckoutId);
      const unreadableDatabase = join(unreadableRoot, `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`);
      const identity = repositoryIdentity(home, healthyCheckoutId);
      const snapshot = readySnapshot(identity);
      const store = yield* CodeGraphStore;
      yield* store.activate(healthyDatabase, identity, snapshot, [], [], []);
      yield* store.promote(healthyDatabase, identity, snapshot.id);
      yield* Effect.promise(() => writeFile(join(healthyRoot, 'graph-v2.sqlite'), 'obsolete graph\n'));
      yield* Effect.promise(() => mkdir(unreadableRoot, {recursive: true}));
      yield* Effect.promise(() => writeFile(unreadableDatabase, 'not a sqlite database'));

      const report = yield* inspectAllCodeGraphs(home, {analyze: true});
      expect(report.summary).toMatchObject({
        databaseCount: 2,
        healthyDatabaseCount: 1,
        readySnapshotCount: 1,
        unreadableDatabaseCount: 1,
        viewCount: 1,
      });
      expect(report.obsoleteStores).toMatchObject({fileCount: 1, unsafeEntryCount: 0});
      expect(report.databases.find(database => database.checkoutId === healthyCheckoutId)).toMatchObject({
        health: {integrity: 'ok', readySnapshots: 1},
        healthState: 'checked',
        views: [
          {
            analysis: {
              coverage: {complete: true, topology: {state: 'complete'}},
              statistics: {snapshotEdgeCount: 0, snapshotNodeCount: 0},
            },
            repository: {displayName: 'acme/diagnostics'},
            snapshot: {id: snapshot.id},
          },
        ],
      });
      const unreadable = report.databases.find(database => database.checkoutId === unreadableCheckoutId);
      expect(unreadable?.healthState).toBe('unreadable');
      expect(unreadable?.issues.map(issue => issue.code)).toContain('health-check-failed');
      expect(unreadable?.lifecycle).toContainEqual(
        expect.objectContaining({action: 'retry-observation', disposition: 'observe', state: 'unreadable-store'}),
      );
      const ordinaryStorage = report.databases.find(database => database.checkoutId === healthyCheckoutId)?.storage;
      if (ordinaryStorage?.state !== 'available')
        throw TestError.make({message: 'missing ordinary storage diagnostics'});
      expect(ordinaryStorage.pageStorage).not.toHaveProperty('attribution');
      expect(JSON.stringify(report)).not.toContain(home);
      expect(renderCodeGraphDiagnostics(report)).toContain('Native code graph diagnostics');
      const partialReport = {
        ...report,
        databases: report.databases.map(database => ({
          ...database,
          views: database.views.map(view =>
            view.analysis
              ? {
                  ...view,
                  analysis: {
                    ...view.analysis,
                    coverage: {
                      ...view.analysis.coverage,
                      complete: false,
                      topology: {...view.analysis.coverage.topology, complete: false, state: 'partial' as const},
                    },
                  },
                }
              : view,
          ),
        })),
      };
      expect(renderCodeGraphDiagnostics(partialReport)).toContain(
        'Analysis: partial · 0 observed component(s) · 0 observed communities',
      );

      const deepReport = yield* inspectAllCodeGraphs(home, {deep: true});
      const deepStorage = deepReport.databases.find(database => database.checkoutId === healthyCheckoutId)?.storage;
      if (deepStorage?.state !== 'available') throw TestError.make({message: 'missing deep storage diagnostics'});
      expect(deepStorage.pageStorage).toMatchObject({state: 'available'});
      if (deepStorage.pageStorage.state !== 'available')
        throw TestError.make({message: 'missing deep page diagnostics'});
      expect(deepStorage.pageStorage.attribution).toBeDefined();
      expect(['available', 'unavailable']).toContain(deepStorage.pageStorage.attribution?.state);
      expect(JSON.stringify(deepReport)).not.toContain(home);

      const config: RuntimeConfig = {
        account: 'local',
        agentContextHome: home,
        agentId: 'threadnote',
        manifestPath: join(home, 'manifest.yaml'),
        user: 'tester',
      };
      const output = yield* captureConsole(runCodeGraphDiagnostics(config, {analyze: true, json: true}));
      const commandReport = JSON.parse(output.output) as CodeGraphLocalDiagnosticsReport;
      expect(commandReport).toMatchObject({
        mode: {analyze: true, deep: false},
        summary: {analysisCompleteCount: 1, databaseCount: 2},
        type: 'code-graph-diagnostics',
        version: 2,
      });
      expect(commandReport.databases.find(database => database.checkoutId === healthyCheckoutId)).toMatchObject({
        views: [
          {
            analysis: {coverage: {complete: true, topology: {state: 'complete'}}},
            localAssociation: {available: false, state: 'legacy-unknown'},
          },
        ],
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'shows a verified folder in trusted CLI JSON and human output while public diagnostics stay path-free',
    () =>
      Effect.gen(function* () {
        const home = yield* Effect.promise(() => mkdtemp('threadnote-graph-local-diagnostics-'));
        const repository = yield* Effect.sync(localRepository);
        homes.push(home, repository);
        const identity = yield* resolveRepositoryIdentity(repository);
        const snapshot = readySnapshot(identity);
        const database = join(
          home,
          'indexes',
          'code-graph',
          'repositories',
          identity.checkoutId,
          `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
        );
        const store = yield* CodeGraphStore;
        yield* store.activate(database, identity, snapshot, [], [], []);
        yield* store.promote(database, identity, snapshot.id);
        yield* recordVerifiedCodeGraphLocalAssociation(home, identity);
        const config: RuntimeConfig = {
          account: 'local',
          agentContextHome: home,
          agentId: 'threadnote',
          manifestPath: join(home, 'manifest.yaml'),
          user: 'tester',
        };

        const publicReport = yield* inspectAllCodeGraphs(home);
        expect(JSON.stringify(publicReport)).not.toContain(identity.repoRoot);

        let gitInvocationCount = 0;
        const command = yield* CommandExecutor;
        const mutableCommand = command as {execute: typeof command.execute};
        const execute = command.execute;
        const repeatedLocalRefreshes = yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            mutableCommand.execute = (executable, args, options) => {
              if (executable === 'git') gitInvocationCount += 1;
              return execute(executable, args, options);
            };
          }),
          () =>
            Effect.all(
              [
                inspectAllCodeGraphsLocal(home),
                managerGraphCatalog(home),
                inspectAllCodeGraphsLocal(home),
                managerGraphCatalog(home),
              ],
              {concurrency: 1},
            ),
          () =>
            Effect.sync(() => {
              mutableCommand.execute = execute;
            }),
        );
        expect(repeatedLocalRefreshes[0].databases[0]?.views[0]?.localAssociation).toMatchObject({
          available: true,
          path: identity.repoRoot,
          state: 'verified',
        });
        expect(repeatedLocalRefreshes[1].repositories[0]?.views[0]?.localAssociation).toMatchObject({
          available: true,
          path: identity.repoRoot,
          state: 'verified',
        });
        expect(gitInvocationCount).toBe(0);

        const fileSystem = yield* FileSystem.FileSystem;
        const failingFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          exists: target =>
            target === identity.repoRoot
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: 'PermissionDenied',
                    description: 'injected disconnected worktree',
                    method: 'exists',
                    module: 'FileSystem',
                    pathOrDescriptor: String(target),
                  }),
                )
              : fileSystem.exists(target),
        });
        const continuity = yield* Effect.all([inspectAllCodeGraphsLocal(home), managerGraphCatalog(home)], {
          concurrency: 1,
        }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem));
        expect(continuity[0].databases[0]).toMatchObject({
          health: {integrity: 'ok'},
          views: [{localAssociation: {available: false, state: 'invalid'}}],
        });
        expect(continuity[1]).toMatchObject({
          diagnostics: [],
          repositories: [{views: [{localAssociation: {available: false, state: 'invalid'}}]}],
        });
        const jsonOutput = yield* captureConsole(runCodeGraphDiagnostics(config, {json: true}));
        const localReport = JSON.parse(jsonOutput.output) as CodeGraphLocalDiagnosticsReport;
        expect(localReport).toMatchObject({
          databases: [
            {
              views: [
                {
                  localAssociation: {
                    available: true,
                    path: identity.repoRoot,
                    state: 'verified',
                  },
                },
              ],
            },
          ],
          version: 2,
        });

        const humanOutput = yield* captureConsole(runCodeGraphDiagnostics(config, {}));
        expect(humanOutput.output).toContain(`Folder: ${identity.repoRoot} · verified`);
        yield* releaseManagerGraphSnapshotLeases();
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('advances one missing-view reconciliation during a local diagnostics opportunity', () =>
    Effect.gen(function* () {
      const temporaryHome = yield* Effect.promise(() => mkdtemp('threadnote-graph-live-status-'));
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.realPath(temporaryHome);
      const repository = yield* Effect.sync(localRepository);
      const worktreeRoot = yield* Effect.promise(() => mkdtemp('threadnote-graph-live-status-worktree-'));
      const linked = join(worktreeRoot, 'linked');
      homes.push(home, repository, worktreeRoot);
      yield* Effect.sync(() => {
        execFileSync('git', ['-C', repository, 'branch', 'manager-live-refresh'], {stdio: 'pipe'});
        execFileSync('git', ['-C', repository, 'worktree', 'add', '-q', linked, 'manager-live-refresh'], {
          stdio: 'pipe',
        });
        execFileSync(
          'git',
          [
            '-C',
            linked,
            '-c',
            'user.name=Threadnote Test',
            '-c',
            'user.email=test@threadnote.local',
            'commit',
            '--allow-empty',
            '-qm',
            'linked fixture',
          ],
          {stdio: 'pipe'},
        );
      });
      const mainIdentity = yield* resolveRepositoryIdentity(repository);
      const linkedIdentity = yield* resolveRepositoryIdentity(linked);
      const mainSnapshot = readySnapshot(mainIdentity, 'd');
      const linkedSnapshot = readySnapshot(linkedIdentity, 'e');
      const database = join(
        home,
        'indexes',
        'code-graph',
        'repositories',
        mainIdentity.checkoutId,
        `graph-v${CODE_GRAPH_SCHEMA_VERSION}.sqlite`,
      );
      const store = yield* CodeGraphStore;
      yield* store.activate(database, mainIdentity, mainSnapshot, [], [], []);
      yield* store.promote(database, mainIdentity, mainSnapshot.id);
      yield* store.activate(database, linkedIdentity, linkedSnapshot, [], [], []);
      yield* store.promote(database, linkedIdentity, linkedSnapshot.id);
      yield* recordVerifiedCodeGraphLocalAssociation(home, mainIdentity);
      yield* recordVerifiedCodeGraphLocalAssociation(home, linkedIdentity);
      yield* Effect.sync(() =>
        execFileSync('git', ['-C', repository, 'worktree', 'remove', '--force', linked], {stdio: 'pipe'}),
      );

      const beforeRevision = yield* observeManagerGraphCatalogRevision(home);
      const stale = yield* inspectAllCodeGraphsLocal(home);
      expect(stale.summary.viewCount).toBe(2);
      expect(stale.databases[0]?.views).toContainEqual(
        expect.objectContaining({localAssociation: expect.objectContaining({state: 'missing'})}),
      );

      const activeViews = yield* store.loadActiveViewIdentities(database, 8);
      expect(activeViews).toHaveLength(1);
      expect(activeViews[0]?.worktreeId).toBe(mainIdentity.worktreeId);
      const status = yield* managerGraphBuildCatalog(home);
      expect(status.catalogRevision).not.toBe(beforeRevision);
      expect(status.lifecyclePending).toBe(false);
      expect(status.reconciliation).toMatchObject({
        blockedRepositories: 0,
        pendingRepositories: 0,
        state: 'observed',
      });

      const refreshed = yield* inspectAllCodeGraphsLocal(home);
      expect(refreshed.summary.viewCount).toBe(1);
      expect(refreshed.databases[0]?.views[0]?.viewWorktreeId).toBe(mainIdentity.worktreeId);
      yield* releaseManagerGraphSnapshotLeases();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function localRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'threadnote-code-graph-diagnostics-repository-'));
  execFileSync('git', ['-C', root, 'init', '-q'], {stdio: 'pipe'});
  execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ],
    {stdio: 'pipe'},
  );
  return root;
}

function repositoryIdentity(root: string, checkoutId: string): RepositoryIdentity {
  return {
    caseMode: 'sensitive',
    checkoutId,
    displayName: 'acme/diagnostics',
    gitCommonDirectory: join(root, '.git'),
    headCommit: 'abcdef0123456789abcdef0123456789abcdef01',
    objectFormat: 'sha1',
    repoRoot: root,
    repositoryId: '3'.repeat(64),
    worktreeId: '4'.repeat(64),
  };
}

function readySnapshot(identity: RepositoryIdentity, id = 'd'): CodeGraphSnapshot {
  return {
    commit: identity.headCommit,
    completedAt: '2026-08-05T08:00:00.000Z',
    dirty: false,
    edgeCount: 0,
    extractorSet: 'diagnostics-test',
    fileCount: 0,
    id: `cgsn_${id.repeat(40)}`,
    repositoryId: identity.repositoryId,
    state: 'ready',
    symbolCount: 0,
    worktreeId: identity.worktreeId,
  };
}
import {execFileSync} from '@threadnote/testing/node-child-process';
import {mkdtempSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
