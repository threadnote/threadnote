import {it as effectIt} from '@effect/vitest';
import {Clock, Effect, Fiber, FileSystem, Path, Result, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {expect, vi} from 'vitest';
import type {CodeGraphStatus} from '@threadnote/graph/types';
import * as candidates from '@threadnote/memory/candidate';
import * as draftController from '../../src/memory/context/maintenance_draft.js';
import {handleManagerAttentionRequest} from '../../src/manager/attention.js';
import {withAutomaticReviewCodeObservations} from '../../src/memory/context/maintenance_review_code_observation.js';
import {CodeGraphIndexer} from '@threadnote/graph/indexer';
import {CodeGraphQueryService} from '@threadnote/graph/query';
import {captureMemoryCodeCitations} from '@threadnote/context/citation/capture';
import {formatMemoryDocument} from '@threadnote/memory/document';
import {runCommandEffect} from '@threadnote/platform/command';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {handleManagerAutomaticMemory} from '../../src/manager/automatic_memory.js';
import {
  readManagerReviewEligibility,
  invalidateManagerReviewReadiness,
} from '../../src/manager/review_actionability.js';
import {requestAutomaticMemoryReview} from '../../src/memory/context/maintenance_draft.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const fixture = Effect.fn('managerAutomaticReviewLoading.fixture')(function* (
  outcome: 'propose-update' | 'propose-revalidation' | 'insufficient-evidence' | 'policy-conflict' = 'propose-update',
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'review-loading-'});
  const root = path.join(home, 'repository');
  yield* fs.makeDirectory(root);
  const git = (args: readonly string[]) => runCommandEffect('git', ['-C', root, ...args]);
  yield* git(['init', '--quiet']);
  const files = ['source.ts', 'second.ts', 'third.ts', 'fourth.ts'];
  for (const [index, file] of files.entries())
    yield* fs.writeFileString(path.join(root, file), `export const timeout${index} = 60;\n`);
  yield* git(['add', '.']);
  yield* git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const config: RuntimeConfig = {
    account: 'local',
    agentContextHome: home,
    agentId: 'test',
    user: 'tester',
    manifestPath: path.join(home, 'manifest.yaml'),
  };
  yield* fs.writeFileString(
    config.manifestPath,
    `version: 1\nprojects:\n  - name: fixture\n    path: ${JSON.stringify(root)}\n    uri: threadnote://resources/repos/fixture\n    seed: []\n`,
  );
  yield* (yield* CodeGraphIndexer).index({cwd: root, threadnoteHome: home, ensureVectors: false});
  const citations = yield* captureMemoryCodeCitations(config, {callerCwd: root, refs: files});
  const uri = 'threadnote://user/tester/memories/durable/projects/fixture/target.md';
  const target = path.join(home, 'data/local/user/tester/memories/durable/projects/fixture/target.md');
  const content = formatMemoryDocument(
    'MEMORY',
    {
      kind: 'durable',
      status: 'active',
      schemaVersion: 10,
      memoryId: 'tn_review_loading',
      project: 'fixture',
      topic: 'review-loading',
      sourceAgentClient: 'test',
      timestamp: '2026-10-25T00:00:00.000Z',
      codeCitations: [...citations],
    },
    'The timeout is 30 seconds.',
  );
  yield* fs.makeDirectory(path.dirname(target), {recursive: true});
  yield* fs.writeFileString(target, content);
  const input = {uri, expectedContentHash: sha256HexSync(content)};
  const packet = yield* requestAutomaticMemoryReview(config, input);
  if ('reviewId' in packet) throw new Error('Expected a synthetic evidence packet.');
  expect(packet.reviewEvidence).toHaveLength(4);
  const handle = packet.reviewEvidence[0];
  const proposed = yield* requestAutomaticMemoryReview(config, {
    ...input,
    draftJson: JSON.stringify({
      version: 2,
      kind: 'automatic',
      purpose: 'automatic',
      targetHash: packet.basis.targetHash,
      observationRevision: packet.basis.observationRevision,
      packetDigest: packet.basis.packetDigest,
      outcome,
      operations:
        outcome === 'propose-update'
          ? [
              {
                ordinal: 0,
                beforeHash: packet.basis.paragraphs[0].hash,
                text: 'The timeout is 60 seconds.',
                supportHandles: [handle.handleId],
                rationale: 'Synthetic current code.',
              },
            ]
          : [],
      reviewedHandles: outcome === 'propose-revalidation' || outcome === 'propose-update' ? [handle.handleId] : [],
      rationale: 'Synthetic explicit review.',
      unresolvedQuestions: [],
      removedClaims: [],
      paragraphDecisions: [
        {
          ordinal: 0,
          beforeHash: packet.basis.paragraphs[0].hash,
          role: 'descriptive',
          support: outcome === 'propose-update' || outcome === 'propose-revalidation' ? 'direct' : 'unresolved',
          evidenceIds: outcome === 'propose-update' || outcome === 'propose-revalidation' ? [handle.descriptor.id] : [],
        },
      ],
    }),
  });
  if (!('reviewId' in proposed)) throw new Error('Expected a stored synthetic review.');
  const read = () =>
    handleManagerAutomaticMemory({
      config,
      method: 'GET',
      url: new URL(`http://manager.test/api/attention/automatic-review?project=fixture&reviewId=${proposed.reviewId}`),
      body: Effect.succeed({}),
    });
  return {
    read,
    fs,
    path,
    root,
    target,
    uri,
    content,
    config,
    review: yield* candidates.loadCandidateReview(home, proposed.reviewId),
  };
});

effectIt.effect(
  'groups unavailable code readiness and restores the exact generated proposal without waiving its whole source vector',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      if (f.review.maintenance?.version !== 3) throw new Error('Expected automatic review');
      const generated = {
        ...f.review,
        maintenance: {
          ...f.review.maintenance,
          generation: {
            origin: 'model' as const,
            agent: 'local-ai',
            model: 'fixture',
            promptVersion: 'fixture',
            attempts: 1 as const,
            usage: {status: 'unavailable' as const},
          },
        },
      };
      yield* candidates.saveCandidateReview(f.config.agentContextHome, generated);
      expect(generated.maintenance.basis.reads.filter(read => read.uri.startsWith('code:'))).toHaveLength(4);
      expect((yield* readManagerReviewEligibility(f.config, [generated])).pendingCount).toBe(1);
      const query = yield* CodeGraphQueryService;
      const stale: CodeGraphQueryService['Service'] = {
        ...query,
        status: (...args) =>
          query.status(...args).pipe(Effect.map(status => ({...status, stale: true, freshness: 'stale' as const}))),
      };
      invalidateManagerReviewReadiness(f.config);
      const unavailable = yield* readManagerReviewEligibility(f.config, [generated]).pipe(
        Effect.provideService(CodeGraphQueryService, stale),
      );
      expect(unavailable.pendingCount).toBe(0);
      expect(unavailable.background.awaitingSources).toBe(1);
      expect(unavailable.background.obsolete).toBe(0);
      const withheld = yield* f.read().pipe(Effect.provideService(CodeGraphQueryService, stale));
      expect(withheld).toMatchObject({
        status: 200,
        body: {kind: 'topic-maintenance-recovery', reason: 'source-unavailable'},
      });
      expect(JSON.stringify(withheld)).not.toContain('The timeout is');
      invalidateManagerReviewReadiness(f.config);
      expect((yield* readManagerReviewEligibility(f.config, [generated])).pendingCount).toBe(1);
      expect(yield* f.fs.readFileString(f.target)).toBe(f.content);
      expect(yield* candidates.loadCandidateReview(f.config.agentContextHome, generated.reviewId)).toEqual(generated);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

effectIt.effect(
  'opens a four-source exact review with two live observations and withholds drift at its closing fence',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const query = yield* CodeGraphQueryService;
      let calls = 0;
      const observed: CodeGraphQueryService['Service'] = {
        ...query,
        status: (...args) => Effect.sync(() => calls++).pipe(Effect.andThen(query.status(...args))),
      };
      const opened = yield* f.read().pipe(Effect.provideService(CodeGraphQueryService, observed));
      expect(opened).toMatchObject({status: 200, body: {kind: 'automatic-memory-review', project: 'fixture'}});
      expect(calls).toBe(2);
      expect(yield* f.fs.readFileString(f.target)).toBe(f.content);
      calls = 0;
      const changed: CodeGraphQueryService['Service'] = {
        ...query,
        status: (...args) =>
          Effect.gen(function* () {
            if (++calls === 2)
              yield* f.fs.writeFileString(f.path.join(f.root, 'source.ts'), 'export const timeout0 = 90;\n');
            return yield* query.status(...args);
          }),
      };
      const withheld = yield* f.read().pipe(Effect.provideService(CodeGraphQueryService, changed));
      expect(withheld).toMatchObject({status: 200, body: {kind: 'topic-maintenance-recovery'}});
      expect(JSON.stringify(withheld)).not.toContain('The timeout');
      expect(yield* f.fs.readFileString(f.target)).toBe(f.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
);

for (const outcome of ['propose-update', 'propose-revalidation', 'insufficient-evidence', 'policy-conflict'] as const) {
  effectIt.effect(`classifies ${outcome} through the real status, read and preparation adapters`, () =>
    Effect.gen(function* () {
      const f = yield* fixture(outcome);
      const call = (method: string, url: string, body: Record<string, unknown> = {}) =>
        handleManagerAutomaticMemory({
          config: f.config,
          method,
          url: new URL(url, 'http://manager.test'),
          body: Effect.succeed(body),
        });
      const actionable = outcome === 'propose-update' || outcome === 'propose-revalidation';
      const listing = yield* call(
        'GET',
        `/api/attention/automatic-memory?project=fixture&uri=${encodeURIComponent(f.uri)}`,
      );
      expect(listing).toMatchObject({
        status: 200,
        body: {items: [{state: actionable ? 'ready' : 'policy', reviewId: f.review.reviewId}]},
      });
      const opened = yield* f.read();
      if (!opened || !('kind' in opened.body) || opened.body.kind !== 'automatic-memory-review')
        throw new Error('Expected an authorized synthetic review.');
      expect(opened.body.revision).toBe(f.review.revision);
      expect(opened.body.approval).toBeUndefined();
      expect(opened.body.proposal.draft.outcome).toBe(outcome);
      if (!actionable) expect(opened.body.proposal.body).toBe(opened.body.acceptedBody);
      const selection = {
        action: 'preview',
        project: 'fixture',
        reviewId: opened.body.reviewId,
        revision: opened.body.revision,
      };
      const prepared = yield* call('POST', '/api/attention/automatic-review', selection);
      if (actionable) {
        expect(prepared).toMatchObject({
          status: 200,
          body: {revision: f.review.revision + 1, canApply: true, approval: {stage: 'preview'}},
        });
        const stale = yield* call('POST', '/api/attention/automatic-review', selection);
        expect(stale?.status).toBe(409);
      } else {
        expect(prepared).toMatchObject({
          status: 409,
          body: {error: 'Topic maintenance acceptance: automatic review has no acceptable update.'},
        });
        const unchanged = yield* candidates.loadCandidateReview(f.config.agentContextHome, f.review.reviewId);
        expect(unchanged.revision).toBe(f.review.revision);
        expect(unchanged.maintenanceApproval).toBeUndefined();
        expect(unchanged.candidates[0].state).toBe('pending');
      }
      expect(yield* f.fs.readFileString(f.target)).toBe(f.content);
    }).pipe(TestClock.withLive, provideTestLayer(ApplicationLayer)),
  );
}

const status: CodeGraphStatus = {
  databasePath: '/synthetic/graph.sqlite',
  freshness: 'current',
  identity: {
    caseMode: 'sensitive',
    checkoutId: 'checkout',
    displayName: 'synthetic',
    gitCommonDirectory: '/synthetic/repository/.git',
    headCommit: '1'.repeat(40),
    objectFormat: 'sha1',
    repoRoot: '/synthetic/repository',
    repositoryId: 'repository',
    worktreeId: 'worktree',
  },
  languagePacks: [],
  readySnapshot: {
    commit: '1'.repeat(40),
    dirty: false,
    edgeCount: 1,
    extractorSet: 'extractor',
    fileCount: 1,
    id: 'snapshot',
    repositoryId: 'repository',
    state: 'ready',
    symbolCount: 1,
    worktreeId: 'worktree',
  },
  stale: false,
};
const options = {manifestPath: '/synthetic/manifest.yaml', observeWorktree: true, requestMaintenance: false};
const read = (project?: string) =>
  CodeGraphQueryService.pipe(
    Effect.flatMap(query => query.status('/synthetic/home', '/synthetic/repository', {...options, project})),
  );
const service = (observe: CodeGraphQueryService['Service']['status']) =>
  CodeGraphQueryService.of({status: observe} as unknown as CodeGraphQueryService['Service']);

effectIt.effect('finishes sixteen repeated two-second observations within the thirty-second read deadline', () =>
  Effect.gen(function* () {
    let calls = 0;
    const started = yield* Clock.currentTimeMillis;
    const verification = Effect.forEach(Array.from({length: 16}), () => read()).pipe(
      withAutomaticReviewCodeObservations,
      Effect.timeout('30 seconds'),
      Effect.provideService(
        CodeGraphQueryService,
        service(() => Effect.sync(() => calls++).pipe(Effect.andThen(Effect.sleep('2 seconds')), Effect.as(status))),
      ),
    );
    const fiber = yield* verification.pipe(Effect.forkChild);
    yield* TestClock.adjust('4 seconds');
    expect(yield* Fiber.join(fiber)).toHaveLength(16);
    expect(calls).toBe(2);
    expect((yield* Clock.currentTimeMillis) - started).toBe(4000);
  }),
);

effectIt.effect.prop(
  'performs exactly one opening and closing check per selected project within each read',
  {
    projects: Schema.Array(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 3}))).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(32),
    ),
  },
  ({projects}) =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const program = Effect.forEach(projects, project => read(String(project))).pipe(
        withAutomaticReviewCodeObservations,
        Effect.provideService(
          CodeGraphQueryService,
          service((_home, _cwd, selected) =>
            Effect.sync(() => {
              calls.push(selected!.project!);
              return status;
            }),
          ),
        ),
      );
      expect(yield* program).toEqual(projects.map(() => status));
      expect(calls).toHaveLength(new Set(projects).size * 2);
      yield* program;
      expect(calls).toHaveLength(new Set(projects).size * 4);
    }),
  {arbitrary: {runs: 24}},
);

for (const [change, after] of [
  ['source drift', {...status, stale: true}],
  ['unavailable observation', {...status, freshness: 'deferred' as const}],
  ['snapshot replacement', {...status, readySnapshot: {...status.readySnapshot!, id: 'replacement'}}],
  ['repository access change', {...status, identity: {...status.identity, repositoryId: 'other'}}],
  [
    'scope change',
    {
      ...status,
      projectCoverage: {
        project: 'other',
        kind: 'project' as const,
        configuredRoots: ['src'],
        rootComponents: 1,
        dependencyComponents: 0,
        completeness: 'complete' as const,
        negativeProof: 'selected-graph-only' as const,
        observedWorktreeCommit: status.identity.headCommit,
        reusedEquivalentSnapshot: false,
      },
    },
  ],
] as const) {
  effectIt.effect(`withholds the result after closing ${change}`, () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* Effect.all([read(), read()]).pipe(
        withAutomaticReviewCodeObservations,
        Effect.provideService(
          CodeGraphQueryService,
          service(() => Effect.succeed(++calls === 1 ? status : after)),
        ),
        Effect.result,
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toBe(2);
    }),
  );
}

effectIt.effect('does not reuse stale observations, observer callbacks, or maintenance-capable reads', () =>
  Effect.gen(function* () {
    let calls = 0;
    const query = service(() => Effect.sync(() => calls++).pipe(Effect.as({...status, stale: true})));
    yield* Effect.forEach(Array.from({length: 4}), () => read()).pipe(
      withAutomaticReviewCodeObservations,
      Effect.provideService(CodeGraphQueryService, query),
    );
    expect(calls).toBe(4);
    const live = service(() => Effect.sync(() => calls++).pipe(Effect.as(status)));
    yield* CodeGraphQueryService.pipe(
      Effect.flatMap(selected =>
        Effect.forEach([{}, {...options, afterIdentityObserved: () => Effect.void}], extra =>
          selected.status('/synthetic/home', '/synthetic/repository', {...extra, observeWorktree: true}),
        ),
      ),
      withAutomaticReviewCodeObservations,
      Effect.provideService(CodeGraphQueryService, live),
    );
    expect(calls).toBe(6);
  }),
);

effectIt.effect('loads All project summaries within eight seconds without checking private source prose', () =>
  Effect.gen(function* () {
    const f = yield* fixture().pipe(TestClock.withLive);
    const reviews = Array.from({length: 8}, (_, index) => ({
      ...f.review,
      reviewId: `review-${String(index).padStart(24, '0')}`,
      project: index % 2 ? 'other project' : 'fixture',
      topic: 'Synthetic private topic',
      task: 'Synthetic private task',
      createdAt: `2026-10-25T00:00:0${index}.000Z`,
      candidates: f.review.candidates.map(candidate => ({...candidate, reason: 'Synthetic private reason'})),
    }));
    yield* Effect.acquireUseRelease(
      Effect.sync(() => ({
        list: vi.spyOn(candidates, 'listCandidateReviews').mockReturnValue(Effect.succeed(reviews)),
        check: vi
          .spyOn(draftController, 'readTopicMaintenanceDraft')
          .mockImplementation((_config, id) =>
            Effect.sleep('9 seconds').pipe(Effect.as(reviews.find(review => review.reviewId === id)!)),
          ),
      })),
      spies =>
        Effect.gen(function* () {
          const list = (project = '', view = 'pending') =>
            handleManagerAttentionRequest({
              config: f.config,
              method: 'GET',
              url: new URL(`http://manager.test/api/reviews?project=${encodeURIComponent(project)}&view=${view}`),
            });
          const fiber = yield* list().pipe(Effect.timeout('8 seconds'), Effect.result, Effect.forkChild);
          yield* TestClock.adjust('8 seconds');
          const loaded = yield* Fiber.join(fiber);
          expect(Result.isSuccess(loaded)).toBe(true);
          if (Result.isFailure(loaded)) return;
          expect(loaded.success).toMatchObject({status: 200, body: {pendingCount: 8, project: ''}});
          const response = loaded.success;
          if (response?.status !== 200 || !('items' in response.body) || !response.body.items)
            throw new Error('Expected an inbox.');
          expect(response.body.items.map(review => review.reviewId)).toEqual(
            reviews.map(review => review.reviewId).reverse(),
          );
          expect(JSON.stringify(response)).not.toMatch(/Synthetic private|The timeout|target\.md/u);
          expect(
            response.body.items.every(review => review.candidates.every(candidate => candidate.proposedText === '')),
          ).toBe(true);
          for (const project of ['fixture', 'other project']) {
            const selected = yield* list(project);
            expect(selected).toMatchObject({status: 200, body: {project, pendingCount: 4}});
            if (selected?.status !== 200 || !('items' in selected.body) || !selected.body.items)
              throw new Error('Expected selected inbox.');
            expect(selected.body.items).toHaveLength(4);
            expect(selected.body.items.every(review => review.project === project)).toBe(true);
          }
          for (const view of ['history', 'deferred'])
            expect(yield* list('', view)).toMatchObject({status: 200, body: {pendingCount: 8, items: []}});
          expect(spies.check).not.toHaveBeenCalled();
          expect(yield* f.fs.readFileString(f.target)).toBe(f.content);
        }),
      spies =>
        Effect.sync(() => {
          spies.list.mockRestore();
          spies.check.mockRestore();
        }),
    );
  }).pipe(provideTestLayer(ApplicationLayer)),
);
