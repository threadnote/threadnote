import {Array as EffectArray, String as EffectString} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {Cause, Deferred, Effect, Exit, Fiber, Schema} from 'effect';
import {expect} from 'vitest';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import type {CodeGraphIndexSummary, CodeGraphStatus} from '@threadnote/graph/types';
import {closeoutDiagnostics} from './native-closeout-diagnostics.js';

const graphStatusResult = (privateValue: string) =>
  ({
    databasePath: '/fixture/graph.sqlite',
    freshness: 'current',
    identity: {
      caseMode: 'sensitive',
      checkoutId: 'fixture-checkout',
      displayName: 'fixture',
      gitCommonDirectory: '/fixture/.git',
      headCommit: EffectString.repeat(40)('a'),
      objectFormat: 'sha1',
      repoRoot: '/fixture',
      repositoryId: 'fixture-repository',
      worktreeId: 'fixture-worktree',
    },
    languagePacks: [],
    readySnapshot: {
      commit: EffectString.repeat(40)('a'),
      dirty: false,
      edgeCount: 0,
      extractorSet: 'fixture',
      fileCount: 0,
      id: 'fixture-snapshot',
      repositoryId: 'fixture-repository',
      state: 'ready',
      symbolCount: 0,
      worktreeId: 'fixture-worktree',
    },
    private: privateValue,
    stale: false,
  }) satisfies CodeGraphStatus & {readonly private: string};

const graphQuery = (status: Parameters<typeof CodeGraphQueryService.of>[0]['status']) =>
  CodeGraphQueryService.of({
    attachSharedReadySnapshot: () => Effect.die('unused'),
    inspect: () => Effect.die('unused'),
    purge: () => Effect.die('unused'),
    status,
    statusForIdentity: () => Effect.die('unused'),
    statusForPublishedIdentity: () => Effect.die('unused'),
  });

const graphIndexSummary = (status: CodeGraphStatus): CodeGraphIndexSummary => {
  const snapshot = status.readySnapshot;
  if (!snapshot) throw new Error('Expected a ready graph fixture snapshot.');
  return {diagnostics: [], durationMs: 0, identity: status.identity, reusedFiles: 0, skippedFiles: 0, snapshot};
};

const graphIndexer = (index: Parameters<typeof CodeGraphIndexer.of>[0]['index'] = () => Effect.die('unused')) =>
  CodeGraphIndexer.of({
    ensureCommit: () => Effect.die('unused'),
    index,
  });

effectIt.effect('keeps only the closed profile in the failure snapshot', () =>
  Effect.sync(() => {
    const observer = closeoutDiagnostics(() => 4);
    observer.setProfile({private: 'arbitrary profile'});
    const report = observer.snapshot();
    expect(report).toMatchObject({version: 2, profile: 'desktop', graphOperationDropped: 0});
    expect(JSON.stringify(report)).not.toContain('arbitrary profile');
    expect(JSON.stringify(report)).not.toContain('private');
  }),
);

effectIt.effect('records the pre-index, index and post-index calls in order without retaining inputs or results', () =>
  Effect.gen(function* () {
    const observer = closeoutDiagnostics(() => 0);
    const statusResult = graphStatusResult('status-result');
    const query = graphQuery(() => Effect.succeed(statusResult));
    const indexer = graphIndexer(() => Effect.succeed(graphIndexSummary(statusResult)));
    const program = observer
      .graph(
        Effect.gen(function* () {
          const queryService = yield* CodeGraphQueryService;
          const indexService = yield* CodeGraphIndexer;
          expect(yield* queryService.status('private-home', 'private-repo')).toBe(statusResult);
          yield* indexService.index({cwd: 'fixture', threadnoteHome: 'fixture'});
          expect(yield* queryService.status('private-home', 'private-repo')).toBe(statusResult);
        }),
      )
      .pipe(Effect.provideService(CodeGraphQueryService, query), Effect.provideService(CodeGraphIndexer, indexer));

    yield* program;
    const report = observer.snapshot();
    expect(report.graphOperations).toMatchObject([
      {operation: 'status-before', ordinal: 1, stage: 'graph-ready', outcome: 'Success'},
      {operation: 'index', ordinal: 1, stage: 'graph-ready', outcome: 'Success'},
      {operation: 'status-after', ordinal: 1, stage: 'graph-ready', outcome: 'Success'},
    ]);
    expect(JSON.stringify(report)).not.toContain('status-result');
    expect(JSON.stringify(report)).not.toContain('private-repo');
  }),
);

effectIt.effect('reserves first-started graph samples before later calls complete', () =>
  Effect.gen(function* () {
    const observer = closeoutDiagnostics();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const statusResult = graphStatusResult('graph-result');
    let calls = 0;
    const query = graphQuery(() =>
      Effect.suspend(() => {
        calls++;
        return calls === 1
          ? Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return statusResult;
            })
          : Effect.succeed(statusResult);
      }),
    );
    const indexer = graphIndexer();
    const statusCall = () =>
      observer
        .graph(
          Effect.gen(function* () {
            const queryService = yield* CodeGraphQueryService;
            return yield* queryService.status('private-home', 'private-repo');
          }),
        )
        .pipe(Effect.provideService(CodeGraphQueryService, query), Effect.provideService(CodeGraphIndexer, indexer));

    const slow = yield* statusCall().pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    for (let index = 0; index < 64; index++) expect(yield* statusCall()).toBe(statusResult);
    const beforeRelease = observer.snapshot();
    expect(beforeRelease.graphOperations).toHaveLength(64);
    expect(beforeRelease.graphOperationDropped).toBe(1);
    expect(beforeRelease.graphOperations[0]).toMatchObject({ordinal: 1, outcome: 'Active'});

    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(slow)).toBe(statusResult);
    const afterRelease = observer.snapshot();
    expect(afterRelease.graphOperations[0]).toMatchObject({ordinal: 1, outcome: 'Success'});
    expect(afterRelease.graphOperations[0].inclusiveMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(afterRelease)).not.toContain('graph-result');
    expect(JSON.stringify(afterRelease)).not.toContain('private-repo');
  }),
);

effectIt.effect('preserves graph wrapper failure, defect and interruption while redacting their inputs', () =>
  Effect.gen(function* () {
    const capture = (status: Effect.Effect<CodeGraphStatus, unknown>) => {
      const observer = closeoutDiagnostics();
      const query = graphQuery(() => status);
      const indexer = graphIndexer();
      const program = observer
        .graph(
          Effect.gen(function* () {
            const queryService = yield* CodeGraphQueryService;
            return yield* queryService.status('private-home', 'private-repo');
          }),
        )
        .pipe(Effect.provideService(CodeGraphQueryService, query), Effect.provideService(CodeGraphIndexer, indexer));
      return {observer, program};
    };
    const typedFailure = {private: 'typed-error'};
    const typed = capture(Effect.fail(typedFailure));
    const typedExit = yield* typed.program.pipe(Effect.exit);
    if (typedExit._tag === 'Failure') expect(Cause.squash(typedExit.cause)).toBe(typedFailure);
    else throw new Error('Expected original typed failure.');
    expect(typed.observer.snapshot().graphOperations).toMatchObject([{outcome: 'Failure'}]);
    expect(JSON.stringify(typed.observer.snapshot())).not.toContain('typed-error');
    expect(JSON.stringify(typed.observer.snapshot())).not.toContain('private-repo');

    const defectValue = {private: 'defect-value'};
    const defect = capture(Effect.die(defectValue));
    const defectExit = yield* defect.program.pipe(Effect.exit);
    if (defectExit._tag === 'Failure') expect(Cause.squash(defectExit.cause)).toBe(defectValue);
    else throw new Error('Expected original defect.');
    expect(defect.observer.snapshot().graphOperations).toMatchObject([{outcome: 'Failure'}]);
    expect(JSON.stringify(defect.observer.snapshot())).not.toContain('defect-value');
    expect(JSON.stringify(defect.observer.snapshot())).not.toContain('private-repo');

    const interrupted = capture(Effect.interrupt);
    const interruptedExit = yield* interrupted.program.pipe(Effect.exit);
    expect(Exit.hasInterrupts(interruptedExit)).toBe(true);
    expect(interrupted.observer.snapshot().graphOperations).toMatchObject([{outcome: 'Failure'}]);
    expect(JSON.stringify(interrupted.observer.snapshot())).not.toContain('private-home');
  }),
);

effectIt.effect.prop(
  'bounds graph operation samples and preserves per-label call ordinals',
  {count: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 96}))},
  ({count}) =>
    Effect.gen(function* () {
      const observer = closeoutDiagnostics(() => 0);
      observer.setProfile('cursor-cloud-personal');
      const statusResult = graphStatusResult('graph-output');
      const query = graphQuery(() => Effect.succeed(statusResult));
      const indexer = graphIndexer();
      const program = observer
        .graph(
          Effect.gen(function* () {
            const queryService = yield* CodeGraphQueryService;
            for (let index = 0; index < count; index++) {
              expect(yield* queryService.status('private-home', 'private-repo')).toBe(statusResult);
            }
          }),
        )
        .pipe(Effect.provideService(CodeGraphQueryService, query), Effect.provideService(CodeGraphIndexer, indexer));

      yield* program;
      const report = observer.snapshot();
      const expectedSamples = Math.min(count, 64);
      expect(report.profile).toBe('cursor-cloud-personal');
      expect(report.graphOperations).toHaveLength(expectedSamples);
      expect(report.graphOperationDropped).toBe(Math.max(0, count - 64));
      expect(EffectArray.map(report.graphOperations, item => item.ordinal)).toEqual(
        Array.from({length: expectedSamples}, (_, index) => index + 1),
      );
      expect(report.graphOperations).toMatchObject(
        Array.from({length: expectedSamples}, () => ({
          operation: 'status-before',
          stage: 'graph-ready',
          outcome: 'Success',
        })),
      );
      expect(JSON.stringify(report)).not.toContain('graph-output');
      expect(JSON.stringify(report)).not.toContain('private-repo');
    }),
  {arbitrary: {runs: 20}},
);
