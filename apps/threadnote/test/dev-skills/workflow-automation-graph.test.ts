import {Array as EffectArray} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Exit, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {runCommandEffect} from '@threadnote/platform/command';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {attachCodeGraphStatusObservation} from '@threadnote/graph/query/contract';
import {CodeGraphStoreBusyError, type CodeGraphIndexSummary, type CodeGraphStatus} from '@threadnote/graph/types';
import {makeWorkflowGraphAdapter} from '../../src/workflow_automation/graph.js';
import type {WorkflowBinding} from '../../src/workflow_memory/protocol.js';
import {nativeFixture, provideNative} from './native-automation-fixture.js';
import * as EffectString from 'effect/String';
import * as EffectOption from 'effect/Option';
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
  options: {readonly prepare?: boolean} = {},
  binding: WorkflowBinding = bindingFor(f),
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
  const adapter = yield* makeWorkflowGraphAdapter(f.config, binding, options).pipe(
    Effect.provideService(CodeGraphQueryService, observedQuery),
    Effect.provideService(CodeGraphIndexer, observedIndexer),
  );
  return {
    adapter,
    counts: () => ({indexCalls, statusCalls}),
  };
});

describe('native workflow graph adapter', () => {
  effectIt.effect('requires selected-project observation even for full coverage', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* runCommandEffect('git', [
        '-C',
        f.repo,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ]);
      yield* f.fs.writeFileString(
        f.config.manifestPath,
        JSON.stringify({
          version: 1,
          projects: [
            {name: 'Alpha', path: f.repo, seed: [], uri: 'threadnote://resources/repos/alpha'},
            {name: 'Beta', path: f.repo, seed: [], uri: 'threadnote://resources/repos/beta'},
          ],
        }),
      );
      const binding = {...bindingFor(f), graphProject: 'Alpha'};
      const full = graphStatus(f.repo);
      const wrong = yield* makeReady(f, [full], () => Effect.die('index must not run'), {prepare: false}, binding);
      expect(yield* wrong.adapter.ready(f.repo).pipe(Effect.result)).toMatchObject({
        failure: {code: 'evidence-unavailable'},
      });
      const selected = attachCodeGraphStatusObservation(
        {...full},
        {
          identity: full.identity,
          projectScopeObserved: true,
          projectScope: {project: {name: 'Alpha', uri: 'threadnote://resources/repos/alpha'}},
        },
      );
      const right = yield* makeReady(f, [selected], () => Effect.die('index must not run'), {prepare: false}, binding);
      expect(yield* right.adapter.ready(f.repo)).toMatchObject({state: 'ready'});
    }).pipe(run),
  );

  effectIt.effect('uses the bound project and names it in preparation guidance', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      yield* runCommandEffect('git', [
        '-C',
        f.repo,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      ]);
      yield* f.fs.writeFileString(
        f.config.manifestPath,
        JSON.stringify({
          version: 1,
          projects: EffectArray.map(['Alpha', 'Beta'], name => ({
            name,
            path: f.repo,
            seed: [],
            uri: `threadnote://resources/repos/${EffectString.toLowerCase(name)}`,
            graph: {closure: 'dependencies', roots: [EffectString.toLowerCase(name)]},
          })),
        }),
      );
      const binding = {...bindingFor(f), graphProject: 'Alpha'};
      const stale = graphStatus(f.repo, {stale: true});
      const fixture = yield* makeReady(f, [stale], () => Effect.die('index must not start'), {prepare: false}, binding);
      const result = yield* fixture.adapter.ready(f.repo).pipe(Effect.result);
      expect(result).toMatchObject({
        failure: {code: 'evidence-unavailable', message: expect.stringContaining('--project Alpha')},
      });
      expect(fixture.counts()).toEqual({indexCalls: 0, statusCalls: 1});
      yield* f.fs.writeFileString(
        f.config.manifestPath,
        JSON.stringify({
          version: 1,
          projects: [{name: 'Beta', path: f.repo, seed: [], uri: 'threadnote://resources/repos/beta'}],
        }),
      );
      expect(yield* makeWorkflowGraphAdapter(f.config, binding).pipe(Effect.result)).toMatchObject({
        failure: {code: 'graph-scope-unavailable'},
      });
    }).pipe(run),
  );

  effectIt.effect('renders the selected project as one executable shell argument', () =>
    Effect.gen(function* () {
      if (process.platform === 'win32') return;
      const f = yield* nativeFixture();
      const projectName = 'Alpha Beta;printf injected';
      yield* f.fs.writeFileString(
        f.config.manifestPath,
        JSON.stringify({
          version: 1,
          projects: [{name: projectName, path: f.repo, seed: [], uri: 'threadnote://resources/repos/alpha'}],
        }),
      );
      const binding = {...bindingFor(f), graphProject: projectName};
      const fixture = yield* makeReady(
        f,
        [graphStatus(f.repo, {stale: true})],
        () => Effect.die('index must not start'),
        {prepare: false},
        binding,
      );
      const result = yield* fixture.adapter.ready(f.repo).pipe(Effect.result);
      if (result._tag !== 'Failure') throw new Error('Expected recovery guidance for a stale graph.');
      const command = Effect2.pipe(
        result.failure.message,
        EffectString.match(/run `([^`]+)` from callerCwd/u),
        EffectOption.getOrUndefined,
      )?.[1];
      if (!command) throw new Error('Expected a bounded executable graph command.');
      const argv = yield* runCommandEffect('sh', ['-c', `set -- ${command}; printf '%s\\n' "$@"`]);
      expect(Effect2.pipe(argv.stdout, EffectString.trimEnd, EffectString.split('\n'))).toEqual([
        'threadnote',
        'graph',
        'index',
        '--no-vectors',
        '--project',
        projectName,
      ]);
    }).pipe(run),
  );

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

  effectIt.effect('refuses stale graph evidence without starting preparation when disabled', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture();
      const stale = graphStatus(f.repo, {stale: true});
      const fixture = yield* makeReady(
        f,
        [stale],
        () => Effect.die('index must not run when preparation is disabled'),
        {prepare: false},
      );
      const failed = yield* fixture.adapter.ready(f.repo).pipe(Effect.result);
      expect(failed).toMatchObject({
        _tag: 'Failure',
        failure: {code: 'evidence-unavailable', retryable: false},
      });
      expect(fixture.counts()).toEqual({indexCalls: 0, statusCalls: 1});
    }).pipe(run),
  );

  effectIt.effect('awaits owned preparation beyond the former cutoff before checking current evidence', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture().pipe(TestClock.withLive);
      const stale = graphStatus(f.repo, {stale: true});
      const current = graphStatus(f.repo);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let optionsSeen: unknown;
      const fixture = yield* makeReady(f, [stale, current], options =>
        Effect.gen(function* () {
          optionsSeen = options;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return completedIndex(stale);
        }),
      );
      const preparation = yield* fixture.adapter.ready(f.repo).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust(175_001);
      expect(preparation.pollUnsafe()).toBeUndefined();
      expect(fixture.counts()).toEqual({indexCalls: 1, statusCalls: 1});
      expect(optionsSeen).toMatchObject({cwd: f.repo, threadnoteHome: f.home, ensureVectors: false});
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(preparation)).toMatchObject({state: 'ready', snapshotId: 'snapshot-fixture'});
      expect(fixture.counts()).toEqual({indexCalls: 1, statusCalls: 2});
    }).pipe(provideNative),
  );

  effectIt.effect('caller interruption finalizes held preparation without a late ready result', () =>
    Effect.gen(function* () {
      const f = yield* nativeFixture().pipe(TestClock.withLive);
      const stale = graphStatus(f.repo, {stale: true});
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let finalized = 0;
      let readyResults = 0;
      const fixture = yield* makeReady(f, [stale, graphStatus(f.repo)], () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(completedIndex(stale)),
          Effect.ensuring(Effect.sync(() => finalized++)),
        ),
      );
      const preparation = yield* fixture.adapter.ready(f.repo).pipe(
        Effect.tap(() => Effect.sync(() => readyResults++)),
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust(175_001);
      yield* Fiber.interrupt(preparation);
      const exit = yield* Fiber.await(preparation);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(finalized).toBe(1);
      expect(fixture.counts()).toEqual({indexCalls: 1, statusCalls: 1});
      yield* Deferred.succeed(release, undefined);
      yield* TestClock.adjust(175_001);
      expect(readyResults).toBe(0);
      expect(finalized).toBe(1);
      expect(fixture.counts()).toEqual({indexCalls: 1, statusCalls: 1});
    }).pipe(provideNative),
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
