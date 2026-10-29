import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {CodeGraphStoreBusyError, type CodeGraphIndexSummary, type CodeGraphStatus} from '@threadnote/graph/types';
import {makeWorkflowGraphAdapter} from '../../src/workflow_automation/graph.js';
import type {WorkflowBinding} from '../../src/workflow_memory/protocol.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(TestClock.withLive, provideNative);

const graphStatus = (repo: string, options: {stale?: boolean; wrongRoot?: boolean; wrongHead?: boolean} = {}) => {
  const identity = {
    caseMode: 'sensitive' as const,
    checkoutId: 'checkout-fixture',
    displayName: 'fixture',
    gitCommonDirectory: `${repo}/.git`,
    headCommit: options.wrongHead
      ? Effect2.pipe('b', EffectString.repeat(40))
      : Effect2.pipe('a', EffectString.repeat(40)),
    objectFormat: 'sha1' as const,
    repoRoot: options.wrongRoot ? `${repo}-other` : repo,
    repositoryId: 'repo-fixture',
    worktreeId: 'worktree-fixture',
  };
  return {
    databasePath: '/private/test-home/code-graph/fixture.sqlite',
    freshness: options.stale ? 'stale' : 'current',
    identity,
    languagePacks: [],
    readySnapshot: {
      commit: options.wrongHead ? Effect2.pipe('c', EffectString.repeat(40)) : identity.headCommit,
      dirty: false,
      edgeCount: 1,
      extractorSet: 'native-test',
      fileCount: 1,
      graphContentId: 'graph-content-fixture',
      id: 'snapshot-fixture',
      repositoryId: identity.repositoryId,
      state: 'ready' as const,
      symbolCount: 1,
      worktreeId: identity.worktreeId,
    },
    stale: options.stale ?? false,
  } satisfies CodeGraphStatus;
};

const completedIndex = (status: CodeGraphStatus): CodeGraphIndexSummary => {
  const snapshot = status.readySnapshot;
  if (!snapshot) throw new Error('Expected a ready snapshot in the graph test fixture');
  return {diagnostics: [], durationMs: 0, identity: status.identity, reusedFiles: 0, skippedFiles: 0, snapshot};
};

const bindingFor = (f: Effect.Success<ReturnType<typeof nativeFixture>>): WorkflowBinding => ({
  bindingId: Effect2.pipe('1', EffectString.repeat(64)),
  workflowRunId: 'native-v1-graph-test',
  profile: 'desktop',
  project: 'fixture',
  featureId: 'feature',
  generation: 'generation-v1',
  home: f.home,
  repo: f.repo,
  account: 'local',
  user: 'tester',
  agentId: 'test',
  sharedRoots: [],
  artifactLifetime: 'local-home',
});

const makeReady = Effect.fn('test.workflowAutomationGraph.makeReady')(function* (
  f: Effect.Success<ReturnType<typeof nativeFixture>>,
  statusSequence: readonly CodeGraphStatus[],
  index: (
    options: Parameters<Parameters<typeof CodeGraphIndexer.of>[0]['index']>[0],
  ) => Effect.Effect<CodeGraphIndexSummary, unknown>,
) {
  const query = yield* CodeGraphQueryService;
  const indexer = yield* CodeGraphIndexer;
  let statusCalls = 0;
  const observedQuery = CodeGraphQueryService.of({
    ...query,
    status: () => {
      const status = statusSequence[Math.min(statusCalls, statusSequence.length - 1)];
      statusCalls++;
      return Effect.succeed(status);
    },
  });
  let indexCalls = 0;
  const observedIndexer = CodeGraphIndexer.of({
    ...indexer,
    index: options => {
      indexCalls++;
      return index(options);
    },
  });
  const adapter = yield* makeWorkflowGraphAdapter(f.config, bindingFor(f)).pipe(
    Effect.provideService(CodeGraphQueryService, observedQuery),
    Effect.provideService(CodeGraphIndexer, observedIndexer),
  );
  return {
    adapter,
    counts: () => ({indexCalls, statusCalls}),
  };
});

describe('native workflow graph adapter', () => {
  effectIt.effect('uses exact current ready source identity without indexing', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const current = graphStatus(f.repo);
      const fixture = yield* makeReady(f, [current], () => Effect.die('index must not run for a current graph'));
      const ready = yield* fixture.adapter.ready(f.repo);
      expect(ready).toEqual({
        state: 'ready',
        snapshotId: 'snapshot-fixture',
        head: Effect2.pipe('a', EffectString.repeat(40)),
        graphContentId: 'graph-content-fixture',
        repositoryRoot: f.repo,
        dirty: false,
      });
      expect(fixture.counts()).toEqual({indexCalls: 0, statusCalls: 1});
    }).pipe(run),
  );

  effectIt.effect('prepares a stale graph once and accepts only its fresh recheck', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const stale = graphStatus(f.repo, {stale: true});
      const current = graphStatus(f.repo);
      let optionsSeen: unknown;
      const fixture = yield* makeReady(f, [stale, current], options => {
        optionsSeen = options;
        return Effect.succeed(completedIndex(stale));
      });
      expect(yield* fixture.adapter.ready(f.repo)).toMatchObject({state: 'ready', snapshotId: 'snapshot-fixture'});
      expect(fixture.counts()).toEqual({indexCalls: 1, statusCalls: 2});
      expect(optionsSeen).toMatchObject({cwd: f.repo, threadnoteHome: f.home, ensureVectors: false});
    }).pipe(run),
  );

  effectIt.effect('fails closed after one preparation when the recheck has stale or mismatched source identity', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const stale = graphStatus(f.repo, {stale: true});
      for (const invalid of [
        graphStatus(f.repo, {stale: true}),
        graphStatus(f.repo, {wrongHead: true}),
        graphStatus(f.repo, {wrongRoot: true}),
      ]) {
        const fixture = yield* makeReady(f, [stale, invalid], () => Effect.succeed(completedIndex(stale)));
        const failed = yield* fixture.adapter.ready(f.repo).pipe(Effect.result);
        expect(failed).toMatchObject({
          _tag: 'Failure',
          failure: {code: 'evidence-not-ready', retryable: true},
        });
        expect(fixture.counts()).toEqual({indexCalls: 1, statusCalls: 2});
      }
    }).pipe(run),
  );

  effectIt.effect('surfaces typed graph writer contention as retryable evidence-busy', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const stale = graphStatus(f.repo, {stale: true});
      const fixture = yield* makeReady(f, [stale], () => Effect.fail(CodeGraphStoreBusyError.of('synthetic busy')));
      const failed = yield* fixture.adapter.ready(f.repo).pipe(Effect.result);
      expect(failed).toMatchObject({
        _tag: 'Failure',
        failure: {
          _tag: 'WorkflowAutomationError',
          code: 'evidence-busy',
          retryable: true,
        },
      });
      expect(fixture.counts()).toEqual({indexCalls: 1, statusCalls: 1});
    }).pipe(run),
  );
});
