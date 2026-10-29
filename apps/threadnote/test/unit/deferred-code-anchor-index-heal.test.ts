import {it as effectIt} from '@effect/vitest';
import {Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CodeGraphIndexer, type CodeGraphIndexerShape} from '@threadnote/graph/indexer';
import type {CodeGraphIndexSummary} from '@threadnote/graph/types';
import {runCommandEffect} from '@threadnote/platform/command';
import {ResourceStore} from '@threadnote/store/resource-store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {SystemInfo} from '@threadnote/platform/system';
import {MEMORY_SCHEMA_VERSION} from '@threadnote/memory/code/citation';
import {
  deferredCodeAnchorDoctorCheck,
  hasDeferredCodeAnchorIntent,
  isDeferredCodeAnchorIntentFilename,
  stageDeferredCodeAnchorIntent,
} from '@threadnote/threadnote/memory/deferred/code_anchor';
import {
  healAfterPublishedGraphIndex,
  withDeferredCodeAnchorIndexHeal,
} from '@threadnote/threadnote/memory/deferred/code_anchor_index_heal';
import {
  DeferredCodeAnchorRefreshScheduler,
  refreshPendingDeferredCodeAnchorWorkspaces,
} from '@threadnote/threadnote/memory/deferred/code_anchor_refresh';
import {formatMemoryDocument, parseMemoryDocument, type MemoryMetadata} from '@threadnote/memory/document';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray} from 'effect';

const WRAP_HEAL_URI = 'threadnote://user/tester/memories/durable/projects/threadnote/wrap-heal.md';

describe('in-process graph-index deferred-anchor recovery', () => {
  effectIt.effect('heals matching intents after a successful in-process index', () => {
    const summary = indexSummary();
    const healed: Array<{readonly cwd: string; readonly home: string; readonly worktreeId: string}> = [];
    const inner = indexer({
      index: () => Effect.succeed(summary),
    });

    return Effect.gen(function* () {
      const published = yield* withDeferredCodeAnchorIndexHeal(inner, (options, publishedSummary) =>
        Effect.sync(() => {
          healed.push({
            cwd: options.cwd,
            home: options.threadnoteHome,
            worktreeId: publishedSummary.identity.worktreeId,
          });
        }),
      ).index({
        cwd: '/repo',
        threadnoteHome: '/threadnote-home',
      });

      expect(published).toBe(summary);
      expect(healed).toEqual([{cwd: '/repo', home: '/threadnote-home', worktreeId: summary.identity.worktreeId}]);
    });
  });

  effectIt.effect('does not heal when index fails', () => {
    const healed: string[] = [];
    const inner = indexer({
      index: () => Effect.fail(TestError.make({message: 'index failed'})),
    });

    return Effect.gen(function* () {
      const failure = yield* withDeferredCodeAnchorIndexHeal(inner, () =>
        Effect.sync(() => {
          healed.push('healed');
        }),
      )
        .index({cwd: '/repo', threadnoteHome: '/threadnote-home'})
        .pipe(Effect.flip);

      expect(failure).toMatchObject({message: 'index failed'});
      expect(healed).toEqual([]);
    });
  });

  effectIt.effect('keeps a successful index when heal fails closed', () => {
    const summary = indexSummary();
    const inner = indexer({
      index: () => Effect.succeed(summary),
    });

    return Effect.gen(function* () {
      expect(
        yield* withDeferredCodeAnchorIndexHeal(inner, () =>
          Effect.fail(TestError.make({message: 'heal failed'})).pipe(Effect.asVoid),
        ).index({
          cwd: '/repo',
          threadnoteHome: '/threadnote-home',
        }),
      ).toBe(summary);
    });
  });

  effectIt.effect('does not heal historical ensureCommit publication', () => {
    const healed: string[] = [];
    const inner = indexer({
      ensureCommit: () => Effect.succeed({leaseToken: 'lease', snapshot: indexSummary().snapshot}),
    });

    return Effect.gen(function* () {
      yield* withDeferredCodeAnchorIndexHeal(inner, () =>
        Effect.sync(() => {
          healed.push('healed');
        }),
      ).ensureCommit({
        commit: Effect2.pipe('b', EffectString.repeat(40)),
        cwd: '/repo',
        threadnoteHome: '/threadnote-home',
      });
      expect(healed).toEqual([]);
    });
  });

  effectIt.effect('skips published-graph heal when the Threadnote home has no data tree', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-heal-absent-data-'});
        yield* healAfterPublishedGraphIndex(home, home, {
          repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
          worktreeId: Effect2.pipe('b', EffectString.repeat(64)),
        });
        expect(yield* fs.exists(path.join(home, 'data'))).toBe(false);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('skips published-graph heal when data is not a directory', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-heal-data-file-'});
        const dataPath = path.join(home, 'data');
        yield* fs.writeFileString(dataPath, 'not-a-tree\n');
        yield* healAfterPublishedGraphIndex(home, home, {
          repositoryId: Effect2.pipe('a', EffectString.repeat(64)),
          worktreeId: Effect2.pipe('b', EffectString.repeat(64)),
        });
        expect(yield* fs.readFileString(dataPath)).toBe('not-a-tree\n');
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'finalizes a matching intent after ApplicationLayer in-process index',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-wrap-heal-'});
          const repository = path.join(root, 'repository');
          const home = path.join(root, 'home');
          const manifestPath = path.join(home, 'seed-manifest.yaml');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.makeDirectory(home, {recursive: true});
          yield* fs.writeFileString(path.join(repository, 'src', 'heal.ts'), 'export const wrapHeal = "ready";\n');
          yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
          yield* runCommandEffect('git', ['init', '--quiet'], {cwd: repository}).pipe(TestClock.withLive);
          yield* runCommandEffect('git', ['add', '.'], {cwd: repository}).pipe(TestClock.withLive);
          yield* runCommandEffect(
            'git',
            [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '--quiet',
              '--message',
              'fixture',
            ],
            {cwd: repository},
          ).pipe(TestClock.withLive);

          const config: RuntimeConfig = {
            account: 'local',
            agentContextHome: home,
            agentId: 'threadnote',
            manifestPath,
            user: 'tester',
          };
          const metadata: MemoryMetadata = {
            kind: 'durable',
            memoryId: 'tn_wrap_heal',
            project: 'threadnote',
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'test',
            status: 'active',
            timestamp: '2026-09-10T00:00:00.000Z',
            topic: 'wrap-heal',
            visibility: 'personal',
          };
          const body = 'Wrap heal must cite after in-process index.';
          const content = formatMemoryDocument('MEMORY', metadata, body);
          const store = yield* ResourceStore;
          const location = {account: config.account, home, user: config.user} as const;
          yield* store.write(location, WRAP_HEAL_URI, content, {mode: 'create'});
          yield* stageDeferredCodeAnchorIntent(config, {
            memoryContent: content,
            memoryMetadata: metadata,
            memoryUri: WRAP_HEAL_URI,
            request: {
              callerCwd: repository,
              codeRefs: ['src/heal.ts'],
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
            },
          });
          const pendingRoot = path.join(
            home,
            'data',
            'local',
            'user',
            'tester',
            'private',
            'deferred-code-anchors',
            'v1',
          );
          expect(
            EffectArray.filter(
              yield* fs.readDirectory(pendingRoot, {recursive: true}),
              __effectArrayValue =>
                !!(name => isDeferredCodeAnchorIntentFilename(path.basename(name)))(__effectArrayValue),
            ),
          ).toHaveLength(1);

          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: home}).pipe(TestClock.withLive);

          expect(
            EffectArray.filter(
              yield* fs.readDirectory(pendingRoot, {recursive: true}),
              __effectArrayValue =>
                !!(name => isDeferredCodeAnchorIntentFilename(path.basename(name)))(__effectArrayValue),
            ),
          ).toEqual([]);
          const finalized = parseMemoryDocument(WRAP_HEAL_URI, yield* store.read(location, WRAP_HEAL_URI));
          expect(finalized?.body).toBe(body);
          expect(finalized?.metadata).toMatchObject({
            codeCitations: [{path: 'src/heal.ts'}],
            memoryId: metadata.memoryId,
            status: metadata.status,
          });
        }),
      ).pipe(withTesterUser, provideTestLayer(ApplicationLayer)),
    60_000,
  );

  effectIt.effect(
    'does not rebind a deleted worktree intent onto a sibling checkout during wrap-heal',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-wrap-heal-sibling-'});
          const repository = path.join(root, 'repository');
          const sibling = path.join(root, 'sibling');
          const home = path.join(root, 'home');
          const manifestPath = path.join(home, 'seed-manifest.yaml');
          yield* fs.makeDirectory(path.join(repository, 'src'), {recursive: true});
          yield* fs.makeDirectory(home, {recursive: true});
          yield* fs.writeFileString(path.join(repository, 'src', 'heal.ts'), 'export const wrapHeal = "ready";\n');
          yield* fs.writeFileString(manifestPath, 'version: 1\nprojects: []\n');
          yield* runCommandEffect('git', ['init', '--quiet'], {cwd: repository}).pipe(TestClock.withLive);
          yield* runCommandEffect('git', ['add', '.'], {cwd: repository}).pipe(TestClock.withLive);
          yield* runCommandEffect(
            'git',
            [
              '-c',
              'user.name=Threadnote Test',
              '-c',
              'user.email=test@threadnote.local',
              'commit',
              '--quiet',
              '--message',
              'fixture',
            ],
            {cwd: repository},
          ).pipe(TestClock.withLive);
          yield* runCommandEffect('git', ['worktree', 'add', '--quiet', sibling, 'HEAD'], {cwd: repository}).pipe(
            TestClock.withLive,
          );

          const config: RuntimeConfig = {
            account: 'local',
            agentContextHome: home,
            agentId: 'threadnote',
            manifestPath,
            user: 'tester',
          };
          const metadata: MemoryMetadata = {
            kind: 'durable',
            memoryId: 'tn_wrap_heal_sibling',
            project: 'threadnote',
            schemaVersion: MEMORY_SCHEMA_VERSION,
            sourceAgentClient: 'test',
            status: 'active',
            timestamp: '2026-09-10T00:00:00.000Z',
            topic: 'wrap-heal-sibling',
            visibility: 'personal',
          };
          const body = 'Deleted sibling worktree must stay uncited.';
          const content = formatMemoryDocument('MEMORY', metadata, body);
          const store = yield* ResourceStore;
          const location = {account: config.account, home, user: config.user} as const;
          yield* store.write(location, WRAP_HEAL_URI, content, {mode: 'create'});
          yield* stageDeferredCodeAnchorIntent(config, {
            memoryContent: content,
            memoryMetadata: metadata,
            memoryUri: WRAP_HEAL_URI,
            request: {
              callerCwd: sibling,
              codeRefs: ['src/heal.ts'],
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
            },
          });
          yield* fs.remove(sibling, {recursive: true});

          const indexer = yield* CodeGraphIndexer;
          yield* indexer.index({cwd: repository, ensureVectors: false, threadnoteHome: home}).pipe(TestClock.withLive);

          expect(yield* hasDeferredCodeAnchorIntent(config, WRAP_HEAL_URI)).toBe(true);
          expect(parseMemoryDocument(WRAP_HEAL_URI, yield* store.read(location, WRAP_HEAL_URI))).toMatchObject({
            body,
            metadata: {memoryId: metadata.memoryId, status: metadata.status},
          });
          expect(
            parseMemoryDocument(WRAP_HEAL_URI, yield* store.read(location, WRAP_HEAL_URI))?.metadata.codeCitations
              ?.length ?? 0,
          ).toBe(0);

          yield* refreshPendingDeferredCodeAnchorWorkspaces(config).pipe(
            Effect.provideService(
              DeferredCodeAnchorRefreshScheduler,
              DeferredCodeAnchorRefreshScheduler.of({schedule: () => Effect.void}),
            ),
          );

          expect(yield* hasDeferredCodeAnchorIntent(config, WRAP_HEAL_URI)).toBe(false);
          expect(
            parseMemoryDocument(WRAP_HEAL_URI, yield* store.read(location, WRAP_HEAL_URI))?.metadata.codeCitations
              ?.length ?? 0,
          ).toBe(0);
          expect(yield* deferredCodeAnchorDoctorCheck(config)).toMatchObject({status: 'ok'});
        }),
      ).pipe(withTesterUser, provideTestLayer(ApplicationLayer)),
    60_000,
  );
});

function withTesterUser<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const system = yield* SystemInfo;
    return yield* effect.pipe(
      Effect.provideService(
        SystemInfo,
        SystemInfo.of({
          ...system,
          environment: () => ({...system.environment(), THREADNOTE_USER: 'tester'}),
        }),
      ),
    );
  });
}

function indexer(overrides: Partial<CodeGraphIndexerShape>): CodeGraphIndexerShape {
  return {
    ensureCommit: () => Effect.die(TestError.make({message: 'unexpected ensureCommit'})),
    index: () => Effect.die(TestError.make({message: 'unexpected index'})),
    ...overrides,
  };
}

function indexSummary(): CodeGraphIndexSummary {
  return {
    diagnostics: [],
    durationMs: 1,
    identity: {
      caseMode: 'sensitive',
      checkoutId: Effect2.pipe('a', EffectString.repeat(64)),
      displayName: 'fixture',
      gitCommonDirectory: '/repo/.git',
      headCommit: Effect2.pipe('b', EffectString.repeat(40)),
      objectFormat: 'sha1',
      repoRoot: '/repo',
      repositoryId: Effect2.pipe('c', EffectString.repeat(64)),
      worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
    },
    reusedFiles: 0,
    skippedFiles: 0,
    snapshot: {
      commit: Effect2.pipe('b', EffectString.repeat(40)),
      completedAt: '2026-09-10T00:00:00.000Z',
      dirty: false,
      edgeCount: 0,
      extractorSet: Effect2.pipe('e', EffectString.repeat(64)),
      fileCount: 1,
      id: `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`,
      repositoryId: Effect2.pipe('c', EffectString.repeat(64)),
      state: 'ready',
      symbolCount: 1,
      worktreeId: Effect2.pipe('d', EffectString.repeat(64)),
    },
  };
}
