import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Array as EffectArray, Effect, FileSystem} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {it as effectIt} from '@effect/vitest';
import {describe, expect, it} from 'vitest';
import {
  assertPerformanceControlSet,
  assertManagerVisualizationBounds,
  benchmarkConcurrentWorktreeIsolation,
  benchmarkManagerPerformance,
  benchmarkStorageEnvironment,
  privacySafeExternalControlPath,
  privacySafeExternalControlQuery,
  publicGitHubRepositoryEvidence,
  retainedExternalControlEvidence,
  retryManagerBenchmarkBusy,
  type ExternalQueryControlResult,
  type ExternalRepositoryQueryControl,
} from '../../../../scripts/benchmark-code-graph.js';
import {prepareCodeGraphFixture} from '../../../../scripts/code-graph-fixture.js';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {ManagerGraphBusyError, type ManagerGraphNode} from '@threadnote/graph/visualization';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';

const PERFORMANCE_CONTROLS = [
  {expectedLanguage: 'java', expectedPath: 'src/Main.java', query: 'Main'},
  {expectedLanguage: 'kotlin', expectedPath: 'src/App.kt', query: 'App'},
  {expectedLanguage: 'typescript', expectedPath: 'src/index.ts', query: 'indexSymbol'},
  {expectedLanguage: 'bazel-build', expectedPath: 'build/rules.bzl', query: 'buildRule'},
] as const satisfies readonly ExternalRepositoryQueryControl[];

describe('external performance evidence', () => {
  effectIt.effect('retries the Manager busy contract without weakening other failures', () =>
    Effect.gen(function* () {
      let attempts = 0;
      const result = yield* retryManagerBenchmarkBusy(
        () => {
          attempts += 1;
          return attempts < 3
            ? Effect.fail(ManagerGraphBusyError.make({message: 'busy'}))
            : Effect.succeed('measured' as const);
        },
        2,
        0,
      );

      expect(result).toBe('measured');
      expect(attempts).toBe(3);

      const terminal = TestError.make({message: 'terminal'});
      const observed = yield* retryManagerBenchmarkBusy(() => Effect.fail(terminal), 2, 0).pipe(Effect.flip);
      expect(observed).toBe(terminal);
    }),
  );

  it('normalizes only public GitHub identities and privacy-safe controls', () => {
    expect(publicGitHubRepositoryEvidence('https://github.com/JetBrains/intellij-community.git')).toEqual({
      name: 'JetBrains/intellij-community',
      url: 'https://github.com/JetBrains/intellij-community',
    });
    expect(publicGitHubRepositoryEvidence('git@github.com:JetBrains/intellij-community.git')).toEqual({
      name: 'JetBrains/intellij-community',
      url: 'https://github.com/JetBrains/intellij-community',
    });
    expect(publicGitHubRepositoryEvidence('ssh://git@github.com/JetBrains/intellij-community.git')).toEqual({
      name: 'JetBrains/intellij-community',
      url: 'https://github.com/JetBrains/intellij-community',
    });
    expect(() => publicGitHubRepositoryEvidence('https://token@github.com/owner/repository.git')).toThrow(
      'public GitHub repository URL',
    );
    expect(() => publicGitHubRepositoryEvidence('/local/private/repository')).toThrow('public GitHub repository URL');
    expect(privacySafeExternalControlQuery('  ProgressManager  ')).toBe('ProgressManager');
    expect(privacySafeExternalControlPath('src/main.ts')).toBe('src/main.ts');
    expect(() => privacySafeExternalControlQuery('customer secret phrase')).toThrow('privacy-safe public symbol');
    expect(() => privacySafeExternalControlPath('../outside.ts')).toThrow('repository-relative paths');
    for (const sensitive of [
      '/Users/alice/private-repository',
      '/home/alice/private-repository',
      '/mnt/c/Users/alice/private-repository',
      '/c/Users/alice/private-repository',
      'C:/Users/alice/private-repository',
      'C:\\Users\\alice\\private-repository',
      '\\\\server\\share\\private-repository',
      `ghp_${Effect2.pipe('a', EffectString.repeat(32))}`,
      `sk-proj-${Effect2.pipe('a', EffectString.repeat(32))}`,
    ]) {
      expect(() => privacySafeExternalControlQuery(sensitive)).toThrow('privacy-safe public symbol');
      expect(() => privacySafeExternalControlPath(sensitive)).toThrow('repository-relative paths');
    }
    expect(privacySafeExternalControlPath('src/home/component.ts')).toBe('src/home/component.ts');
  });

  it('normalizes equivalent public GitHub transports and repository-relative paths', () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,20}$/);
    fc.assert(
      fc.property(segment, segment, (owner, repository) => {
        const expected = {name: `${owner}/${repository}`, url: `https://github.com/${owner}/${repository}`};
        expect(publicGitHubRepositoryEvidence(`https://github.com/${owner}/${repository}.git`)).toEqual(expected);
        expect(publicGitHubRepositoryEvidence(`git@github.com:${owner}/${repository}.git`)).toEqual(expected);
        expect(publicGitHubRepositoryEvidence(`ssh://git@github.com/${owner}/${repository}.git`)).toEqual(expected);
      }),
    );
    fc.assert(
      fc.property(
        fc.array(
          segment.filter(value => value !== '.' && value !== '..'),
          {minLength: 1, maxLength: 8},
        ),
        segments => {
          const portable = EffectArray.join(segments, '/');
          expect(privacySafeExternalControlPath(portable)).toBe(portable);
          expect(privacySafeExternalControlPath(EffectArray.join(segments, '\\'))).toBe(portable);
        },
      ),
    );
  });

  it('requires the release evidence language set and emits deterministic stable-node controls', () => {
    assertPerformanceControlSet(PERFORMANCE_CONTROLS);
    expect(() => assertPerformanceControlSet(PERFORMANCE_CONTROLS.slice(0, 3))).toThrow('exactly java, kotlin');
    expect(() => assertPerformanceControlSet([...PERFORMANCE_CONTROLS, PERFORMANCE_CONTROLS[0]])).toThrow(
      'exactly java, kotlin',
    );
    const results: readonly ExternalQueryControlResult[] = EffectArray.map(PERFORMANCE_CONTROLS, (control, index) => ({
      digest: Effect2.pipe(`${index}`, EffectString.repeat(64)),
      durationMilliseconds: index + 1,
      expectedMatches: 1,
      language: control.expectedLanguage,
      returnedNodes: 2,
      stableNodeId: `cgs_${Effect2.pipe(String(index + 1), EffectString.repeat(32))}`,
    }));
    expect(JSON.parse(retainedExternalControlEvidence(PERFORMANCE_CONTROLS, results))).toEqual({
      bazel: {
        path: 'build/rules.bzl',
        query: 'buildRule',
        stableNodeId: `cgs_${Effect2.pipe('4', EffectString.repeat(32))}`,
      },
      java: {path: 'src/Main.java', query: 'Main', stableNodeId: `cgs_${Effect2.pipe('1', EffectString.repeat(32))}`},
      kotlin: {path: 'src/App.kt', query: 'App', stableNodeId: `cgs_${Effect2.pipe('2', EffectString.repeat(32))}`},
      typescript: {
        path: 'src/index.ts',
        query: 'indexSymbol',
        stableNodeId: `cgs_${Effect2.pipe('3', EffectString.repeat(32))}`,
      },
    });
  });

  effectIt.effect('reports only privacy-safe filesystem and storage-medium categories', () =>
    Effect.gen(function* () {
      const evidence = yield* benchmarkStorageEnvironment(process.cwd()).pipe(provideTestLayer(ApplicationLayer));
      expect(evidence.filesystem).toMatch(/^[a-z0-9._+-]+$/);
      expect(['external', 'internal', 'unknown']).toContain(evidence.location);
      expect(['rotational', 'solid-state', 'unknown', 'virtual-or-network']).toContain(evidence.medium);
    }),
  );

  it('rejects Manager responses that exceed or misreport their requested graph budget', () => {
    const limits = {edgeLimit: 1_500, nodeLimit: 500};
    const bounded = {edges: [], nodes: [], paging: {...limits, hasMore: false}};
    const excessNode: ManagerGraphNode = {
      degree: 0,
      id: 'fixture-symbol',
      kind: 'function',
      label: 'fixture symbol',
      projectId: 'fixture-project',
      type: 'symbol',
    };
    expect(() => assertManagerVisualizationBounds('bounded', bounded, limits)).not.toThrow();
    expect(() =>
      assertManagerVisualizationBounds(
        'too many nodes',
        {...bounded, nodes: Array.from({length: limits.nodeLimit + 1}, () => excessNode)},
        limits,
      ),
    ).toThrow('exceeded or misreported');
    expect(() =>
      assertManagerVisualizationBounds(
        'misreported paging',
        {...bounded, paging: {...bounded.paging, edgeLimit: limits.edgeLimit - 1}},
        limits,
      ),
    ).toThrow('exceeded or misreported');
  });

  effectIt.effect(
    'measures real Manager catalog, visualization, detail, query, payload, and client layout preparation',
    () =>
      Effect.gen(function* () {
        const evidence = yield* Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* prepareCodeGraphFixture('code-graph-v1');
            const indexer = yield* CodeGraphIndexer;
            const summary = yield* indexer.index({cwd: fixture.repository, threadnoteHome: fixture.home});
            return yield* benchmarkManagerPerformance(
              fixture.home,
              summary.identity.repositoryId,
              summary.snapshot.id,
              'exclusive file lock',
              2,
              1,
            );
          }),
        ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);

        expect(evidence.catalogColdMilliseconds).toHaveLength(1);
        expect(evidence.catalogWarmMilliseconds).toHaveLength(2);
        expect(evidence.overviewColdMilliseconds).toHaveLength(1);
        expect(evidence.overviewWarmMilliseconds).toHaveLength(2);
        expect(evidence.detailColdMilliseconds).toHaveLength(1);
        expect(evidence.nodeDetailColdMilliseconds).toHaveLength(1);
        expect(evidence.queryMilliseconds).toHaveLength(2);
        expect(evidence.queryPayloadBytes).toHaveLength(2);
        expect(evidence.layoutPreparationProxyMilliseconds).toHaveLength(2);
        expect(evidence.overviewNodeCount).toBeGreaterThan(0);
        expect(evidence.detailNodeCount).toBeGreaterThan(0);
        expect(EffectArray.every(evidence.maxResponsePayloadBytes, bytes => bytes > 0)).toBe(true);
        expect(evidence).toMatchObject({
          edgeBudget: 1_500,
          nodeBudget: 500,
          requestCancellationPassed: true,
          snapshotBindingPassed: true,
          staleResponseRejectionPassed: true,
        });
      }),
    30_000,
  );

  effectIt.effect(
    'indexes and reads two dirty linked worktrees concurrently without cross-contamination',
    () =>
      Effect.gen(function* () {
        const evidence = yield* Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-worktree-evidence-home-'});
            return yield* benchmarkConcurrentWorktreeIsolation(home);
          }),
        ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);
        expect(evidence).toMatchObject({
          cleanupPassed: true,
          indexedFiles: 2,
          isolationPassed: true,
          simultaneousWorktrees: 2,
          topology: 'bounded-synthetic-linked-worktrees-in-measured-primary-home',
        });
        expect(evidence.durationMilliseconds).toBeGreaterThan(0);
      }),
    30_000,
  );

  effectIt.effect(
    'cleans interrupted worktree controls without replacing an existing ready snapshot',
    () =>
      Effect.gen(function* () {
        const evidence = yield* Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* prepareCodeGraphFixture('code-graph-v1');
            const indexer = yield* CodeGraphIndexer;
            const query = yield* CodeGraphQueryService;
            const baseline = yield* indexer.index({cwd: fixture.repository, threadnoteHome: fixture.home});
            const failed = yield* benchmarkConcurrentWorktreeIsolation(fixture.home, {
              failureInjection: 'after-index',
            }).pipe(Effect.match({onFailure: () => true, onSuccess: () => false}));
            const status = yield* query.status(fixture.home, fixture.repository);
            return {baselineSnapshotId: baseline.snapshot.id, failed, readySnapshotId: status.readySnapshot?.id};
          }),
        ).pipe(provideTestLayer(ApplicationLayer), TestClock.withLive);
        expect(evidence).toEqual({
          baselineSnapshotId: evidence.baselineSnapshotId,
          failed: true,
          readySnapshotId: evidence.baselineSnapshotId,
        });
      }),
    60_000,
  );

  effectIt.effect('treats an already-removed owned fixture root as a completed teardown', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fixture = yield* prepareCodeGraphFixture('code-graph-v1');
        yield* fs.remove(fixture.root, {force: true, recursive: true});
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});
