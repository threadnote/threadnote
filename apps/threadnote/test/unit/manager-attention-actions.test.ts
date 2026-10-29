import {Array as EffectArray} from 'effect';
import {pipe as EffectArrayPipe} from 'effect';

import {it as effectIt} from '@effect/vitest';
import {Effect, Predicate, Schema} from 'effect';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {beforeEach, describe, expect, vi} from 'vitest';
import {handleManagerAttentionAction} from '../../src/manager/attention_actions.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {ManagerCitationRepairJobV1} from '@threadnote/manager/attention/contracts';
import {ManagerLiveConsumerChangeHints} from '../../src/manager/live_consumer_observation.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

class StaleCursorTestError extends Schema.TaggedError<StaleCursorTestError, {readonly brand: unique symbol}>()(
  'StaleCursorTestError',
  {
    message: Schema.String,
  },
) {}

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  decide: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  applyBatch: vi.fn(),
  root: vi.fn(),
  records: vi.fn(),
  readByUri: vi.fn(),
  save: vi.fn(),
  lock: vi.fn(),
  indexGraph: vi.fn(),
  maintenanceStatus: vi.fn(),
  maintenancePacket: vi.fn(),
}));
vi.mock('@threadnote/memory/candidate', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/memory/candidate')>()),
  loadCandidateReview: mocks.load,
  saveCandidateReview: mocks.save,
  withCandidateReviewLock: (home: string, reviewId: string, effect: Effect.Effect<unknown, unknown, unknown>) => {
    mocks.lock(home, reviewId);
    return effect;
  },
}));
vi.mock('@threadnote/memory/knowledge_delta', () => ({projectKnowledgeDeltaV1: () => ({revision: 4, items: []})}));
vi.mock('../../src/memory/closeout.js', () => ({runCloseoutApply: mocks.decide}));
vi.mock('../../src/memory/context/health_repair_commands.js', () => ({
  applyContextHealthCitationRepairBatch: mocks.applyBatch,
  previewContextHealthRepairs: mocks.preview,
  applyContextHealthRepair: mocks.apply,
}));
vi.mock('../../src/memory/context/maintenance.js', () => ({
  readContextMaintenanceStatus: mocks.maintenanceStatus,
  readContextMaintenancePacket: mocks.maintenancePacket,
  runContextMaintenance: vi.fn(),
  setContextMaintenancePaused: vi.fn(),
  undoContextMaintenance: vi.fn(),
}));
vi.mock('../../src/manager/attention.js', () => ({managerAttentionProjectRoot: mocks.root}));
vi.mock('../../src/memory/maintenance/records.js', () => ({readActiveProjectMemoryRecords: mocks.records}));
vi.mock('../../src/mcp/server/memory.js', () => ({readMemoryRecordsByUri: mocks.readByUri}));
vi.mock('../../src/manager/graph/actions.js', () => ({runManagerExplicitCwdGraphIndex: mocks.indexGraph}));
const config = {
  agentContextHome: '/test',
  manifestPath: '/test/manifest',
  user: 'tester',
  account: 'local',
  agentId: 'threadnote',
} satisfies RuntimeConfig;
function isCitationRepairJob(value: unknown): value is ManagerCitationRepairJobV1 {
  if (!Predicate.isObject(value) || !Predicate.isObject(value.progress)) return false;
  const {progress} = value;
  return (
    typeof value.createdAt === 'string' &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.finishedAt === undefined || typeof value.finishedAt === 'string') &&
    typeof value.id === 'string' &&
    typeof value.project === 'string' &&
    (value.status === 'completed' || value.status === 'failed' || value.status === 'running') &&
    (value.warning === undefined || typeof value.warning === 'string') &&
    typeof progress.batch === 'number' &&
    typeof progress.failedCount === 'number' &&
    (progress.initialCitationCount === undefined || typeof progress.initialCitationCount === 'number') &&
    typeof progress.message === 'string' &&
    typeof progress.pagesScanned === 'number' &&
    (progress.phase === 'applying' ||
      progress.phase === 'completed' ||
      progress.phase === 'failed' ||
      progress.phase === 'rebuilding' ||
      progress.phase === 'scanning' ||
      progress.phase === 'starting') &&
    typeof progress.repairableCount === 'number' &&
    typeof progress.repairedCount === 'number' &&
    typeof progress.unresolvedCount === 'number'
  );
}

function citationRepairJob(body: unknown): ManagerCitationRepairJobV1 | null {
  if (!Predicate.isObject(body) || !('job' in body)) throw new Error('Citation repair job response is invalid.');
  if (body.job === null) return null;
  if (!isCitationRepairJob(body.job)) throw new Error('Citation repair job response is invalid.');
  return body.job;
}

function afterCursorArgument(call: readonly unknown[]): string | undefined {
  const scope = call[3];
  if (!Predicate.isObject(scope) || typeof scope.after !== 'string') return undefined;
  return scope.after;
}

function request(route: string, body: Record<string, unknown>) {
  return handleManagerAttentionAction({
    config,
    method: 'POST',
    url: new URL(`http://manager.test${route}`),
    body: Effect.succeed({project: 'threadnote', ...body}),
  }).pipe(provideTestLayer(ApplicationLayer));
}
function readCitationRepairJob(project: string) {
  return handleManagerAttentionAction({
    config,
    method: 'GET',
    url: new URL(`http://manager.test/api/context-health/citations/jobs?project=${encodeURIComponent(project)}`),
    body: Effect.succeed({}),
  }).pipe(provideTestLayer(ApplicationLayer));
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockReturnValue(
    Effect.succeed({
      reviewId: 'review-example',
      project: 'threadnote',
      revision: 4,
      auditEvents: [],
      candidates: [
        {
          candidateId: 'candidate-1',
          comparison: 'replacement',
          kind: 'durable',
          project: 'threadnote',
          proposedText: 'Full proposed memory',
          recommendation: 'replace',
          state: 'pending',
          targetUri: 'threadnote://user/tester/memories/durable/projects/threadnote/existing.md',
          topic: 'workflow',
        },
      ],
    }),
  );
  mocks.save.mockReturnValue(Effect.succeed('/test/review-example.json'));
  mocks.readByUri.mockReturnValue(
    Effect.succeed([
      {
        body: '## Decisions\n- Keep the current behavior.',
        content: 'MEMORY\nkind: durable\nstatus: active\n\n## Decisions\n- Keep the current behavior.',
        headerTitle: 'MEMORY',
        metadata: {
          kind: 'durable',
          project: 'threadnote',
          sourceAgentClient: 'codex',
          status: 'active',
          timestamp: '2026-09-28T00:00:00.000Z',
          topic: 'workflow',
        },
        uri: 'threadnote://user/tester/memories/durable/projects/threadnote/existing.md',
      },
    ]),
  );
  mocks.decide.mockReturnValue(
    Effect.succeed({content: [{type: 'text', text: 'Applied'}], structuredContent: {revision: 5}}),
  );
  mocks.root.mockReturnValue(Effect.succeed({cwd: '/project', state: 'available'}));
  mocks.records.mockReturnValue(Effect.succeed([]));
  mocks.preview.mockReturnValue(
    Effect.succeed({
      proposals: [
        {
          findingId: 'finding-1',
          proposalId: `health-repair-${Effect2.pipe('a', EffectString.repeat(40))}`,
          revision: Effect2.pipe('b', EffectString.repeat(64)),
        },
      ],
    }),
  );
  mocks.apply.mockReturnValue(Effect.succeed({status: 'applied'}));
  mocks.applyBatch.mockImplementation(
    (_config: RuntimeConfig, input: {readonly proposals: readonly {readonly findingId: string}[]}) =>
      Effect.succeed(
        EffectArray.map(input.proposals, proposal => ({findingId: proposal.findingId, status: 'applied'})),
      ),
  );
  mocks.indexGraph.mockReturnValue(Effect.succeed({output: 'Ready'}));
});

describe('Manager reviewed action adapters', () => {
  effectIt.effect('publishes citation job creation, progress, success, and failure after each state change', () =>
    Effect.gen(function* () {
      const observed: Array<{project: string; status: string; phase: string}> = [];
      const hints = ManagerLiveConsumerChangeHints.of({
        publish: resource =>
          Effect.gen(function* () {
            if (resource.topic !== 'citation-repair-jobs') return;
            const response = yield* readCitationRepairJob(resource.project).pipe(Effect.orDie);
            if (!response) return;
            const job = citationRepairJob(response.body);
            if (job === null) return;
            observed.push({project: resource.project, status: job.status, phase: job.progress.phase});
          }),
      });
      const start = (project: string) =>
        request('/api/context-health/citations/jobs', {project}).pipe(
          Effect.provideService(ManagerLiveConsumerChangeHints, hints),
        );
      const successProject = 'live-citation-success';
      mocks.preview.mockReturnValue(Effect.succeed({proposals: [], omittedProposals: 0, sourceOmittedFindings: 0}));
      expect((yield* start(successProject))?.status).toBe(202);
      for (
        let attempt = 0;
        attempt < 50 &&
        !EffectArray.some(observed, item => item.project === successProject && item.status === 'completed');
        attempt++
      )
        yield* Effect.yieldNow;
      const success = EffectArray.filter(observed, item => item.project === successProject);
      expect(success[0]).toEqual({project: successProject, status: 'running', phase: 'starting'});
      expect(EffectArray.some(success, item => item.status === 'running' && item.phase !== 'starting')).toBe(true);
      expect(success.at(-1)?.status).toBe('completed');

      const failureProject = 'live-citation-failure';
      mocks.indexGraph.mockReturnValue(Effect.fail(StaleCursorTestError.make({message: 'simulated graph failure'})));
      expect((yield* start(failureProject))?.status).toBe(202);
      for (
        let attempt = 0;
        attempt < 50 &&
        !EffectArray.some(observed, item => item.project === failureProject && item.status === 'failed');
        attempt++
      )
        yield* Effect.yieldNow;
      const failure = EffectArray.filter(observed, item => item.project === failureProject);
      expect(failure[0]).toEqual({project: failureProject, status: 'running', phase: 'starting'});
      expect(EffectArray.some(failure, item => item.status === 'running' && item.phase === 'rebuilding')).toBe(true);
      expect(failure.at(-1)?.status).toBe('failed');
      expect(
        EffectArray.every(observed, item => item.project === successProject || item.project === failureProject),
      ).toBe(true);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('forwards spaced project names to maintenance, citation jobs and repair preview', () =>
    Effect.gen(function* () {
      const project = 'Example Project';
      mocks.maintenanceStatus.mockReturnValue(Effect.succeed({version: 2, cases: [], receipts: [], projects: []}));
      const status = yield* handleManagerAttentionAction({
        config,
        method: 'GET',
        body: Effect.succeed({}),
        url: new URL(`http://manager.test/api/attention/context-maintenance?project=${encodeURIComponent(project)}`),
      });
      expect(status?.status).toBe(200);
      expect(mocks.maintenanceStatus).toHaveBeenCalledWith(config, project, expect.any(Object));
      expect((yield* readCitationRepairJob(project))?.status).toBe(200);
      expect((yield* request('/api/context-health/preview', {project, findingId: 'finding-1'}))?.status).toBe(200);
      expect(mocks.root).toHaveBeenCalledWith(config, project);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('routes project-safe retained status pages and exact packets through the GET adapter', () =>
    Effect.gen(function* () {
      const status = {version: 2, cases: [], receipts: [], projects: [], page: {generation: 'bound'}};
      mocks.maintenanceStatus.mockReturnValue(Effect.succeed(status));
      mocks.maintenancePacket.mockReturnValue(Effect.succeed({caseId: 'case-42', project: 'threadnote'}));
      const get = (query: string) =>
        handleManagerAttentionAction({
          config,
          method: 'GET',
          body: Effect.succeed({}),
          url: new URL(`http://manager.test/api/attention/context-maintenance?project=threadnote&${query}`),
        });
      expect((yield* get('caseCursor=case-page&receiptCursor=receipt-page&limit=40'))?.body).toEqual(status);
      expect(mocks.maintenanceStatus).toHaveBeenLastCalledWith(config, 'threadnote', {
        caseCursor: 'case-page',
        receiptCursor: 'receipt-page',
        limit: 40,
        caseId: undefined,
        receiptId: undefined,
      });
      yield* get('caseId=case-42');
      expect(mocks.maintenanceStatus).toHaveBeenLastCalledWith(config, 'threadnote', {caseId: 'case-42'});
      expect(mocks.maintenancePacket).toHaveBeenLastCalledWith(config, 'case-42', {
        citationId: undefined,
        memoryUri: undefined,
      });
      expect((yield* get('limit=1000'))?.status).toBe(400);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect.prop(
    'never applies an arbitrary stale revision',
    {revision: Schema.Int.check(Schema.isBetween({minimum: 5, maximum: 100000}))},
    ({revision}) =>
      Effect.gen(function* () {
        const result = yield* request('/api/reviews/decide', {
          reviewId: 'review-example',
          candidateId: 'candidate-1',
          revision,
          action: 'approve',
          approved: true,
        });
        expect(result?.status).toBe(409);
        expect(mocks.decide).not.toHaveBeenCalled();
      }),
  );
  effectIt.effect('returns a read-only full candidate preview', () =>
    Effect.gen(function* () {
      const result = yield* request('/api/reviews/preview', {reviewId: 'review-example'});
      expect(result?.status).toBe(200);
      expect(JSON.stringify(result?.body)).toContain('Full proposed memory');
      expect(mocks.decide).not.toHaveBeenCalled();
    }),
  );
  effectIt.effect('rejects stale revisions and absent approval before the lifecycle runs', () =>
    Effect.gen(function* () {
      expect(
        (yield* request('/api/reviews/decide', {
          reviewId: 'review-example',
          candidateId: 'candidate-1',
          revision: 3,
          action: 'approve',
          approved: true,
        }))?.status,
      ).toBe(409);
      expect(
        (yield* request('/api/reviews/decide', {
          reviewId: 'review-example',
          candidateId: 'candidate-1',
          revision: 4,
          action: 'approve',
        }))?.status,
      ).toBe(400);
      expect(mocks.decide).not.toHaveBeenCalled();
    }),
  );
  effectIt.effect('refreshes legacy replacement safety under the review lock and advances the revision', () =>
    Effect.gen(function* () {
      const result = yield* request('/api/reviews/refresh-safety', {
        reviewId: 'review-example',
        candidateId: 'candidate-1',
        revision: 4,
      });

      expect(result?.status).toBe(200);
      expect(mocks.lock).toHaveBeenCalledWith('/test', 'review-example');
      expect(mocks.save).toHaveBeenCalledWith(
        '/test',
        expect.objectContaining({
          revision: 5,
          auditEvents: [expect.objectContaining({action: 'refresh_safety', candidateId: 'candidate-1', revision: 5})],
          candidates: [
            expect.objectContaining({
              candidateId: 'candidate-1',
              replacementSafetyBaseline: expect.objectContaining({version: 1}),
              targetContentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
            }),
          ],
        }),
      );
    }),
  );
  effectIt.effect.prop(
    'never refreshes replacement safety from a stale revision',
    {revision: Schema.Int.check(Schema.isBetween({minimum: 5, maximum: 100000}))},
    ({revision}) =>
      Effect.gen(function* () {
        const result = yield* request('/api/reviews/refresh-safety', {
          reviewId: 'review-example',
          candidateId: 'candidate-1',
          revision,
        });
        expect(result?.status).toBe(409);
        expect(mocks.readByUri).not.toHaveBeenCalled();
        expect(mocks.save).not.toHaveBeenCalled();
      }),
  );
  effectIt.effect('fails closed when the candidate is not a replacement or its target is absent', () =>
    Effect.gen(function* () {
      mocks.load.mockReturnValueOnce(
        Effect.succeed({
          reviewId: 'review-example',
          project: 'threadnote',
          revision: 4,
          auditEvents: [],
          candidates: [
            {
              candidateId: 'candidate-1',
              comparison: 'new',
              kind: 'durable',
              project: 'threadnote',
              recommendation: 'create',
              state: 'pending',
              topic: 'workflow',
            },
          ],
        }),
      );
      expect(
        (yield* request('/api/reviews/refresh-safety', {
          reviewId: 'review-example',
          candidateId: 'candidate-1',
          revision: 4,
        }))?.body,
      ).toEqual({error: 'This candidate is not a replacement with a current target.'});

      mocks.readByUri.mockReturnValueOnce(Effect.succeed([]));
      expect(
        (yield* request('/api/reviews/refresh-safety', {
          reviewId: 'review-example',
          candidateId: 'candidate-1',
          revision: 4,
        }))?.body,
      ).toEqual({
        code: 'replacement-target-missing',
        error:
          'The replacement target no longer exists. You can create the reviewed proposal as the current memory instead.',
      });
      expect(mocks.save).not.toHaveBeenCalled();
    }),
  );
  effectIt.effect('delegates approve, defer and reject with the exact revision', () =>
    Effect.gen(function* () {
      for (const action of ['approve', 'defer', 'reject']) {
        expect(
          (yield* request('/api/reviews/decide', {
            reviewId: 'review-example',
            candidateId: 'candidate-1',
            revision: 4,
            action,
            approved: action === 'approve',
          }))?.status,
        ).toBe(200);
        expect(mocks.decide.mock.lastCall?.[1]).toMatchObject({
          reviewId: 'review-example',
          candidateId: 'candidate-1',
          revision: 4,
          action,
        });
      }
    }),
  );
  effectIt.effect('passes explicit missing-target creation approval to the closeout lifecycle', () =>
    Effect.gen(function* () {
      yield* request('/api/reviews/decide', {
        reviewId: 'review-example',
        candidateId: 'candidate-1',
        revision: 4,
        action: 'approve',
        approved: true,
        allowMissingReplacementCreate: true,
        operation: 'create',
      });
      expect(mocks.decide.mock.lastCall?.[1]).toMatchObject({
        allowMissingReplacementCreate: true,
        operation: 'create',
      });
    }),
  );
  effectIt.effect('enforces project ownership and surfaces lifecycle conflicts', () =>
    Effect.gen(function* () {
      expect((yield* request('/api/reviews/preview', {reviewId: 'review-example', project: 'another'}))?.status).toBe(
        400,
      );
      mocks.decide.mockReturnValue(Effect.succeed({isError: true, content: [{type: 'text', text: 'Target changed'}]}));
      expect(
        (yield* request('/api/reviews/decide', {
          reviewId: 'review-example',
          candidateId: 'candidate-1',
          revision: 4,
          action: 'approve',
          approved: true,
        }))?.body,
      ).toEqual({error: 'Target changed'});
    }),
  );
  effectIt.effect('previews health repair without applying and carries exact approval to apply', () =>
    Effect.gen(function* () {
      expect(
        (yield* request('/api/context-health/preview', {
          findingId: 'finding-1',
          findingCategory: 'relation-target-missing',
        }))?.status,
      ).toBe(200);
      expect(mocks.apply).not.toHaveBeenCalled();
      expect(
        (yield* request('/api/context-health/apply', {
          proposalId: `health-repair-${Effect2.pipe('a', EffectString.repeat(40))}`,
          revision: Effect2.pipe('b', EffectString.repeat(64)),
        }))?.status,
      ).toBe(400);
      yield* request('/api/context-health/apply', {
        proposalId: `health-repair-${Effect2.pipe('a', EffectString.repeat(40))}`,
        revision: Effect2.pipe('b', EffectString.repeat(64)),
        approved: true,
        findingCategory: 'relation-target-missing',
        topic: 'workflow',
      });
      expect(mocks.apply.mock.lastCall?.[1]).toMatchObject({
        proposalId: `health-repair-${Effect2.pipe('a', EffectString.repeat(40))}`,
        revision: Effect2.pipe('b', EffectString.repeat(64)),
        approved: true,
        topic: 'workflow',
        cwd: '/project',
      });
    }),
  );

  effectIt.effect('rejects repository-backed repair work when the project has no local repository', () =>
    Effect.gen(function* () {
      mocks.root.mockReturnValue(Effect.succeed({reason: 'project-not-configured', state: 'unavailable'}));
      expect(
        (yield* request('/api/context-health/preview', {
          findingId: 'finding-1',
          findingCategory: 'relation-target-missing',
        }))?.status,
      ).toBe(409);
      expect(
        (yield* request('/api/context-health/apply', {
          proposalId: `health-repair-${Effect2.pipe('a', EffectString.repeat(40))}`,
          revision: Effect2.pipe('b', EffectString.repeat(64)),
          approved: true,
        }))?.status,
      ).toBe(409);
      expect(mocks.preview).not.toHaveBeenCalled();
      expect(mocks.apply).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect('previews, applies, and rebuilds graph evidence for bulk citation repairs', () =>
    Effect.gen(function* () {
      const proposal = {
        category: 'citation-changed',
        findingId: 'citation-finding',
        mutation: {
          citationId: `tncc_${Effect2.pipe('1', EffectString.repeat(40))}`,
          expectedResultContentHash: Effect2.pipe('2', EffectString.repeat(64)),
          kind: 'replace-citation',
          replacement: {
            id: `tncc_${Effect2.pipe('3', EffectString.repeat(40))}`,
            path: 'src/example.ts',
            sourceCommit: Effect2.pipe('4', EffectString.repeat(40)),
            target: {kind: 'file'},
          },
          subjectUri: 'threadnote://user/tester/memories/durable/projects/threadnote/example.md',
        },
        proposalId: `health-repair-${Effect2.pipe('5', EffectString.repeat(40))}`,
        revision: Effect2.pipe('6', EffectString.repeat(64)),
      };
      mocks.preview.mockImplementation(
        (_config: RuntimeConfig, _project: string, _cwd: string, scope: {findingCategories?: readonly string[]}) =>
          Effect.succeed({
            proposals: scope.findingCategories?.includes('citation-changed') === true ? [proposal] : [],
            omittedProposals: 0,
            sourceOmittedFindings: 0,
          }),
      );

      const preview = yield* request('/api/context-health/citations/preview', {});
      expect(preview?.status).toBe(200);
      expect(preview?.body).toMatchObject({repairableCount: 1, requiresGraphCount: 0});

      const applied = yield* request('/api/context-health/citations/apply', {
        approved: true,
        items: [
          {
            category: 'citation-changed',
            citationId: proposal.mutation.citationId,
            findingId: proposal.findingId,
            proposalId: proposal.proposalId,
            replacementId: proposal.mutation.replacement.id,
            revision: proposal.revision,
            subjectUri: proposal.mutation.subjectUri,
          },
        ],
      });
      expect(applied?.body).toMatchObject({appliedCount: 1, failedCount: 0});
      expect(mocks.applyBatch).toHaveBeenCalledWith(config, {project: 'threadnote', proposals: [proposal]});

      expect((yield* request('/api/context-health/citations/rebuild', {}))?.body).toEqual({output: 'Ready'});
      expect(mocks.indexGraph).toHaveBeenCalledWith(config, {cwd: '/project', full: true});
    }),
  );

  effectIt.effect('repairs every citation page in a background job that outlives the start request', () =>
    Effect.gen(function* () {
      const project = 'background-repair';
      const cursor = `hcx1_2s_${Effect2.pipe('a', EffectString.repeat(40))}`;
      const proposal = (suffix: string) => ({
        category: 'citation-changed' as const,
        findingId: `citation-finding-${suffix}`,
        mutation: {
          citationId: `tncc_${Effect2.pipe(suffix, EffectString.repeat(40))}`,
          kind: 'replace-citation' as const,
          replacement: {
            id: `tncc_${suffix === '1' ? Effect2.pipe('2', EffectString.repeat(40)) : Effect2.pipe('4', EffectString.repeat(40))}`,
            path: `src/example-${suffix}.ts`,
            sourceCommit: Effect2.pipe('5', EffectString.repeat(40)),
            target: {kind: 'file' as const},
          },
          subjectUri: `threadnote://user/tester/memories/durable/projects/${project}/example-${suffix}.md`,
        },
        project,
        proposalId: `health-repair-${suffix === '1' ? Effect2.pipe('6', EffectString.repeat(40)) : Effect2.pipe('7', EffectString.repeat(40))}`,
        revision: Effect2.pipe('8', EffectString.repeat(64)),
      });
      let applied = false;
      let staleCursorFailures = 0;
      mocks.preview.mockImplementation(
        (_config: RuntimeConfig, selectedProject: string, _cwd: string, scope: {after?: string}) => {
          if (selectedProject !== project || applied)
            return Effect.succeed({proposals: [], omittedProposals: 0, sourceOmittedFindings: 0});
          if (scope.after === cursor && staleCursorFailures === 0) {
            staleCursorFailures += 1;
            return Effect.die(
              StaleCursorTestError.make({
                message: 'Context-health continuation cursor is invalid or stale; rerun the first page.',
              }),
            );
          }
          return Effect.succeed(
            scope.after === cursor
              ? {proposals: [proposal('3')], omittedProposals: 0, sourceOmittedFindings: 0}
              : {proposals: [proposal('1')], nextCursor: cursor, omittedProposals: 0, sourceOmittedFindings: 1},
          );
        },
      );
      mocks.applyBatch.mockImplementation(
        (_config: RuntimeConfig, input: {readonly proposals: readonly {readonly findingId: string}[]}) => {
          applied = true;
          return Effect.succeed(
            EffectArray.map(input.proposals, item => ({findingId: item.findingId, status: 'applied'})),
          );
        },
      );

      const started = yield* request('/api/context-health/citations/jobs', {project});
      expect(started?.status).toBe(202);
      let job: ManagerCitationRepairJobV1 | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        yield* Effect.yieldNow;
        const response = yield* readCitationRepairJob(project);
        if (response === undefined) continue;
        job = citationRepairJob(response.body);
        if (job?.status === 'completed') break;
      }

      expect(job).toMatchObject({status: 'completed', progress: {repairedCount: 2}});
      expect(mocks.indexGraph).toHaveBeenCalledWith(config, {cwd: '/project', full: false});
      expect(mocks.indexGraph.mock.invocationCallOrder[0]).toBeLessThan(mocks.preview.mock.invocationCallOrder[0] ?? 0);
      expect(mocks.applyBatch).toHaveBeenCalledTimes(1);
      expect(mocks.applyBatch.mock.calls[0]?.[1].proposals).toHaveLength(2);
      expect(
        EffectArray.map(
          EffectArrayPipe(mocks.preview.mock.calls, __effectFilterValues =>
            EffectArray.filter(
              __effectFilterValues,
              (call, __effectFilterIndex) => __effectFilterIndex in __effectFilterValues && call[1] === project,
            ),
          ),
          call => afterCursorArgument(call),
        ),
      ).toEqual([undefined, cursor, undefined, cursor, undefined]);
    }),
  );

  effectIt.effect('stops after bounded stale-cursor defect restarts', () =>
    Effect.gen(function* () {
      const project = 'stale-cursor-exhaustion';
      const cursor = `hcx1_2s_${Effect2.pipe('b', EffectString.repeat(40))}`;
      mocks.preview.mockImplementation(
        (_config: RuntimeConfig, selectedProject: string, _cwd: string, scope: {after?: string}) => {
          if (selectedProject !== project)
            return Effect.succeed({proposals: [], omittedProposals: 0, sourceOmittedFindings: 0});
          if (scope.after === undefined)
            return Effect.succeed({
              proposals: [],
              nextCursor: cursor,
              omittedProposals: 0,
              sourceOmittedFindings: 1,
            });
          return Effect.die(
            StaleCursorTestError.make({
              message: 'Context-health continuation cursor is invalid or stale; rerun the first page.',
            }),
          );
        },
      );

      expect((yield* request('/api/context-health/citations/jobs', {project}))?.status).toBe(202);
      let job: ManagerCitationRepairJobV1 | null = null;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        yield* Effect.yieldNow;
        const response = yield* readCitationRepairJob(project);
        job = response === undefined ? null : citationRepairJob(response.body);
        if (job?.status === 'failed') break;
      }

      expect(job).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('Context-health continuation cursor is invalid or stale'),
      });
      expect(
        EffectArray.map(
          EffectArrayPipe(mocks.preview.mock.calls, __effectFilterValues =>
            EffectArray.filter(
              __effectFilterValues,
              (call, __effectFilterIndex) => __effectFilterIndex in __effectFilterValues && call[1] === project,
            ),
          ),
          call => afterCursorArgument(call),
        ),
      ).toEqual([undefined, cursor, undefined, cursor, undefined, cursor, undefined, cursor]);
      expect(mocks.applyBatch).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect('rescans without writing when the project graph changes after a citation scan', () =>
    Effect.gen(function* () {
      const project = 'source-race';
      const scannedSnapshot = `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`;
      const currentSnapshot = `cgsn_${Effect2.pipe('2', EffectString.repeat(40))}`;
      let scans = 0;
      mocks.indexGraph
        .mockReturnValueOnce(
          Effect.succeed({
            output: 'Ready',
            snapshot: {commit: Effect2.pipe('3', EffectString.repeat(40)), dirty: false, id: scannedSnapshot},
          }),
        )
        .mockReturnValue(
          Effect.succeed({
            output: 'Ready',
            snapshot: {commit: Effect2.pipe('4', EffectString.repeat(40)), dirty: false, id: currentSnapshot},
          }),
        );
      mocks.preview.mockImplementation((_config: RuntimeConfig, selectedProject: string) => {
        if (selectedProject !== project || scans++ > 0)
          return Effect.succeed({proposals: [], omittedProposals: 0, sourceOmittedFindings: 0});
        return Effect.succeed({
          proposals: [
            {
              category: 'citation-changed',
              findingId: 'source-race-finding',
              mutation: {
                citationId: `tncc_${Effect2.pipe('5', EffectString.repeat(40))}`,
                kind: 'replace-citation',
                replacement: {
                  id: `tncc_${Effect2.pipe('6', EffectString.repeat(40))}`,
                  path: 'src/example.ts',
                  sourceCommit: Effect2.pipe('3', EffectString.repeat(40)),
                  sourceSnapshotId: scannedSnapshot,
                  target: {kind: 'file'},
                },
                subjectUri: `threadnote://user/tester/memories/durable/projects/${project}/example.md`,
              },
              project,
              proposalId: `health-repair-${Effect2.pipe('7', EffectString.repeat(40))}`,
              revision: Effect2.pipe('8', EffectString.repeat(64)),
            },
          ],
          omittedProposals: 0,
          sourceOmittedFindings: 0,
        });
      });

      expect((yield* request('/api/context-health/citations/jobs', {project}))?.status).toBe(202);
      let job: ManagerCitationRepairJobV1 | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        yield* Effect.yieldNow;
        const response = yield* readCitationRepairJob(project);
        job = response === undefined ? null : citationRepairJob(response.body);
        if (job?.status === 'completed') break;
      }

      expect(job).toMatchObject({status: 'completed', progress: {repairedCount: 0}});
      expect(mocks.applyBatch).not.toHaveBeenCalled();
      expect(mocks.indexGraph).toHaveBeenCalledTimes(2);
      expect(mocks.preview).toHaveBeenCalledTimes(2);
    }),
  );

  effectIt.effect('preserves unrelated citation-scan defects', () =>
    Effect.gen(function* () {
      const project = 'unrelated-scan-defect';
      mocks.preview.mockImplementation((_config: RuntimeConfig, selectedProject: string) =>
        selectedProject === project
          ? Effect.die(StaleCursorTestError.make({message: 'Unexpected citation scanner defect.'}))
          : Effect.succeed({proposals: [], omittedProposals: 0, sourceOmittedFindings: 0}),
      );

      expect((yield* request('/api/context-health/citations/jobs', {project}))?.status).toBe(202);
      let job: ManagerCitationRepairJobV1 | null = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        yield* Effect.yieldNow;
        const response = yield* readCitationRepairJob(project);
        job = response === undefined ? null : citationRepairJob(response.body);
        if (job?.status === 'failed') break;
      }

      expect(job).toMatchObject({status: 'failed', error: 'Unexpected citation scanner defect.'});
      expect(
        EffectArrayPipe(mocks.preview.mock.calls, __effectFilterValues =>
          EffectArray.filter(
            __effectFilterValues,
            (call, __effectFilterIndex) => __effectFilterIndex in __effectFilterValues && call[1] === project,
          ),
        ),
      ).toHaveLength(1);
      expect(mocks.applyBatch).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect('returns one requested citation page so Manager can report real progress', () =>
    Effect.gen(function* () {
      const proposal = {
        category: 'citation-missing',
        findingId: 'citation-finding',
        mutation: {
          citationId: `tncc_${Effect2.pipe('1', EffectString.repeat(40))}`,
          kind: 'replace-citation',
          replacement: {
            id: `tncc_${Effect2.pipe('2', EffectString.repeat(40))}`,
            path: 'src/example.ts',
            sourceCommit: Effect2.pipe('3', EffectString.repeat(40)),
            target: {kind: 'file'},
          },
          subjectUri: 'threadnote://user/tester/memories/durable/projects/threadnote/example.md',
        },
        proposalId: `health-repair-${Effect2.pipe('4', EffectString.repeat(40))}`,
        revision: Effect2.pipe('5', EffectString.repeat(64)),
      };
      mocks.preview.mockReturnValueOnce(
        Effect.succeed({proposals: [proposal], nextCursor: `hcx1_2s_${Effect2.pipe('a', EffectString.repeat(40))}`}),
      );

      const result = yield* request('/api/context-health/citations/preview', {
        findingCategory: 'citation-missing',
      });

      expect(result?.body).toMatchObject({
        nextCursor: `hcx1_2s_${Effect2.pipe('a', EffectString.repeat(40))}`,
        repairableCount: 1,
      });
      expect(mocks.preview).toHaveBeenCalledTimes(1);
    }),
  );

  effectIt.effect('rejects a bulk citation item when its reviewed proposal revision changed', () =>
    Effect.gen(function* () {
      const proposal = {
        category: 'citation-changed',
        findingId: 'citation-finding',
        mutation: {
          citationId: `tncc_${Effect2.pipe('1', EffectString.repeat(40))}`,
          kind: 'replace-citation',
          replacement: {id: `tncc_${Effect2.pipe('2', EffectString.repeat(40))}`},
          subjectUri: 'threadnote://user/tester/memories/durable/projects/threadnote/example.md',
        },
        proposalId: `health-repair-${Effect2.pipe('3', EffectString.repeat(40))}`,
        revision: Effect2.pipe('4', EffectString.repeat(64)),
      };
      mocks.preview.mockImplementation(() => Effect.succeed({proposals: [proposal]}));

      const result = yield* request('/api/context-health/citations/apply', {
        approved: true,
        items: [
          {
            category: 'citation-changed',
            citationId: proposal.mutation.citationId,
            findingId: proposal.findingId,
            proposalId: `health-repair-${Effect2.pipe('5', EffectString.repeat(40))}`,
            replacementId: proposal.mutation.replacement.id,
            revision: Effect2.pipe('6', EffectString.repeat(64)),
            subjectUri: proposal.mutation.subjectUri,
          },
        ],
      });

      expect(result?.body).toMatchObject({appliedCount: 0, failedCount: 1});
      expect(mocks.apply).not.toHaveBeenCalled();
      expect(mocks.applyBatch).not.toHaveBeenCalled();
    }),
  );
});
