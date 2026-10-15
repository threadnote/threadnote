import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CodeGraphWatcher} from '@threadnote/graph/watcher';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {runCommandEffect} from '@threadnote/platform/command';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {
  deferredCodeAnchorDoctorCheck,
  hasDeferredCodeAnchorIntent,
  stageDeferredCodeAnchorIntent,
  type DeferredCodeAnchorWriteRequest,
} from '@threadnote/threadnote/memory/deferred/code_anchor';
import {
  DeferredCodeAnchorRefreshScheduler,
  deferredCodeAnchorRefreshSchedulerLayer,
  listDeferredCodeAnchorWorkspaceRefreshTargets,
  refreshPendingDeferredCodeAnchorWorkspaces,
  scheduleDeferredCodeAnchorWorkspaceRefresh,
} from '@threadnote/threadnote/memory/deferred/code_anchor_refresh';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';

const PRESENT_URI = 'threadnote://user/tester/memories/durable/projects/threadnote/present.md';
const MISSING_URI = 'threadnote://user/tester/memories/durable/projects/threadnote/missing.md';

describe('deferred code-anchor workspace refresh', () => {
  effectIt.effect('lists still-present matching worktrees and skips a deleted checkout', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRefreshFixture();
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Present workspace.'),
          memoryMetadata: {...fixture.metadata, memoryId: 'tn_present', topic: 'present'},
          memoryUri: PRESENT_URI,
          request: deferredRequest(fixture.present),
        });
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(
            {...fixture.metadata, memoryId: 'tn_missing', topic: 'missing'},
            'Deleted workspace.',
          ),
          memoryMetadata: {...fixture.metadata, memoryId: 'tn_missing', topic: 'missing'},
          memoryUri: MISSING_URI,
          request: deferredRequest(fixture.missing),
        });
        yield* fixture.fs.remove(fixture.missing, {recursive: true});

        const targets = yield* listDeferredCodeAnchorWorkspaceRefreshTargets(fixture.config);
        expect(targets).toEqual([
          expect.objectContaining({
            cwd: fixture.present,
          }),
        ]);
        expect(targets.some(target => target.cwd === fixture.missing)).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('discards missing-cwd intents during workspace refresh without citing another checkout', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRefreshFixture();
        const presentContent = memoryContent(fixture.metadata, 'Present workspace.');
        const missingMetadata = {...fixture.metadata, memoryId: 'tn_missing', topic: 'missing'};
        const missingContent = memoryContent(missingMetadata, 'Deleted workspace.');
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: presentContent,
          memoryMetadata: fixture.metadata,
          memoryUri: PRESENT_URI,
          request: deferredRequest(fixture.present),
        });
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: missingContent,
          memoryMetadata: missingMetadata,
          memoryUri: MISSING_URI,
          request: deferredRequest(fixture.missing),
        });
        const store = yield* ResourceStore;
        const location = {
          account: fixture.config.account,
          home: fixture.config.agentContextHome,
          user: fixture.config.user,
        } as const;
        yield* store.write(location, PRESENT_URI, presentContent, {mode: 'create'});
        yield* store.write(location, MISSING_URI, missingContent, {mode: 'create'});
        yield* fixture.fs.remove(fixture.missing, {recursive: true});

        yield* refreshPendingDeferredCodeAnchorWorkspaces(fixture.config).pipe(
          Effect.provideService(
            DeferredCodeAnchorRefreshScheduler,
            DeferredCodeAnchorRefreshScheduler.of({
              schedule: () => Effect.void,
            }),
          ),
        );

        expect(yield* hasDeferredCodeAnchorIntent(fixture.config, PRESENT_URI)).toBe(true);
        expect(yield* hasDeferredCodeAnchorIntent(fixture.config, MISSING_URI)).toBe(false);
        expect(
          parseMemoryDocument(MISSING_URI, yield* store.read(location, MISSING_URI))?.metadata.codeCitations?.length ??
            0,
        ).toBe(0);
        const doctor = yield* deferredCodeAnchorDoctorCheck(fixture.config);
        expect(doctor.status).toBe('warn');
        expect(doctor.detail).toMatch(
          /^1 private code-anchor intent\(s\) are pending finalization across 1 worktree\(s\): [a-f0-9]{12} present matching$/,
        );
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('schedules only still-present matching worktrees', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeRefreshFixture();
        const scheduled: {readonly cwd: string; readonly key: string; readonly threadnoteHome: string}[] = [];
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(fixture.metadata, 'Present workspace.'),
          memoryMetadata: {...fixture.metadata, memoryId: 'tn_present', topic: 'present'},
          memoryUri: PRESENT_URI,
          request: deferredRequest(fixture.present),
        });
        yield* stageDeferredCodeAnchorIntent(fixture.config, {
          memoryContent: memoryContent(
            {...fixture.metadata, memoryId: 'tn_missing', topic: 'missing'},
            'Deleted workspace.',
          ),
          memoryMetadata: {...fixture.metadata, memoryId: 'tn_missing', topic: 'missing'},
          memoryUri: MISSING_URI,
          request: deferredRequest(fixture.missing),
        });
        yield* fixture.fs.remove(fixture.missing, {recursive: true});

        yield* refreshPendingDeferredCodeAnchorWorkspaces(fixture.config).pipe(
          Effect.provideService(
            DeferredCodeAnchorRefreshScheduler,
            DeferredCodeAnchorRefreshScheduler.of({
              schedule: options => Effect.sync(() => scheduled.push(options)),
            }),
          ),
        );

        expect(scheduled).toEqual([
          {
            cwd: fixture.present,
            key: (yield* listDeferredCodeAnchorWorkspaceRefreshTargets(fixture.config))[0]?.worktreeId,
            manifestPath: fixture.config.manifestPath,
            threadnoteHome: fixture.config.agentContextHome,
          },
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('schedules still-present worktrees as background builder admission', () =>
    Effect.gen(function* () {
      const fixture = yield* makeRefreshFixture();
      yield* fixture.fs.writeFileString(
        fixture.config.manifestPath,
        `version: 1\nprojects:\n  - name: selected\n    path: ${JSON.stringify(fixture.present)}\n    uri: threadnote://resources/repos/selected\n    seed: []\n    graph:\n      roots: [src]\n      closure: dependencies\n      include: []\n`,
      );
      const scheduled: Array<{readonly admissionClass?: string; readonly cwd: string; readonly project?: string}> = [];
      yield* scheduleDeferredCodeAnchorWorkspaceRefresh(fixture.config, {
        cwd: fixture.present,
        worktreeId: 'a'.repeat(64),
        project: 'selected',
      }).pipe(
        Effect.provideService(CodeGraphQueryService, {status: () => Effect.succeed({} as never)} as never),
        provideTestLayer(
          deferredCodeAnchorRefreshSchedulerLayer.pipe(
            Layer.provide(
              Layer.succeed(
                CodeGraphWatcher,
                CodeGraphWatcher.of({
                  cachedStatus: () => Effect.succeedNone,
                  ensure: () => Effect.void,
                  metrics: Effect.succeed({
                    activeRefreshKeys: 0,
                    activeWatches: 0,
                    executingRefreshes: 0,
                    executingRefreshHighWater: 0,
                    idleSweepFibers: 0,
                    maximumWatchers: 0,
                    pendingTrailingRefreshes: 0,
                    retainedStatuses: 0,
                  }),
                  refresh: options =>
                    Effect.sync(() => {
                      scheduled.push({
                        admissionClass: options.admissionClass,
                        cwd: options.cwd,
                        project: options.project?.name,
                      });
                      return true;
                    }),
                  request: () => Effect.die('Unexpected graph request.'),
                  status: () => Effect.succeedNone,
                  watch: () => Effect.void,
                }),
              ),
            ),
            Layer.provideMerge(ApplicationLayer),
          ),
        ),
      );
      expect(scheduled).toEqual([{admissionClass: 'background', cwd: fixture.present, project: 'selected'}]);
    }).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive),
  );

  effectIt.effect('does not schedule when the refresh scheduler is absent', () =>
    Effect.gen(function* () {
      const scheduled: string[] = [];
      yield* scheduleDeferredCodeAnchorWorkspaceRefresh(
        {agentContextHome: '/threadnote-home', manifestPath: '/missing-manifest.yaml'},
        {cwd: '/repo', worktreeId: 'a'.repeat(64)},
      );
      expect(scheduled).toEqual([]);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

const makeRefreshFixture = Effect.fn('deferredCodeAnchorRefreshTest.makeFixture')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-deferred-anchor-refresh-'});
  const present = path.join(home, 'present');
  const missing = path.join(home, 'missing');
  yield* Effect.forEach([present, missing], cwd => initializeGitCheckout(cwd), {concurrency: 1});
  const manifestPath = path.join(home, 'seed-manifest.yaml');
  yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'threadnote',
    manifestPath,
    user: 'tester',
  };
  const metadata: MemoryMetadata = {
    kind: 'durable',
    memoryId: 'tn_present',
    project: 'threadnote',
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceAgentClient: 'test',
    status: 'active',
    timestamp: '2026-09-10T00:00:00.000Z',
    topic: 'present',
    visibility: 'personal',
  };
  return {config, fs, metadata, missing, path, present};
});

const initializeGitCheckout = Effect.fn('deferredCodeAnchorRefreshTest.initGit')(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cwd);
  yield* runCommandEffect('git', ['init', '--quiet'], {cwd});
  yield* runCommandEffect(
    'git',
    [
      '-c',
      'user.name=Threadnote Test',
      '-c',
      'user.email=test@threadnote.local',
      'commit',
      '--allow-empty',
      '--quiet',
      '--message',
      'fixture',
    ],
    {cwd},
  );
});

function deferredRequest(callerCwd: string): DeferredCodeAnchorWriteRequest {
  return {
    callerCwd,
    codeRefs: ['src/index.ts'],
    recovery: {
      code: 'ready-graph-unavailable',
      indexingStarted: false,
      observedGraph: {freshness: 'stale', readySnapshot: 'absent', stale: true},
      preparation: {
        action: 'index-current-graph',
        arguments: [],
        command: 'threadnote graph index --no-vectors',
        target: 'callerCwd',
      },
      recovery: 'prepare-current-graph',
      retryCondition: 'after-current-graph-ready',
      retryable: true,
      type: 'memory-code-citation-capture-recovery',
      version: 1,
    },
  };
}

function memoryContent(metadata: MemoryMetadata, body: string): string {
  return formatMemoryDocument('MEMORY', metadata, body);
}
