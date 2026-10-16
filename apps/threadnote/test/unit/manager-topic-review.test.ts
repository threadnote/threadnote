import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {beforeEach, describe, expect, vi} from 'vitest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {CandidateReview} from '@threadnote/memory/candidate';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {handleManagerTopicReview, projectManagerTopicReview} from '../../src/manager/topic_review.js';
import {TopicReviewError} from '../../src/memory/context/maintenance_review.js';
import {handleManagerAttentionAction} from '../../src/manager/attention_actions.js';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  load: vi.fn(),
  status: vi.fn(),
  packet: vi.fn(),
  records: vi.fn(),
  root: vi.fn(),
  draft: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  decide: vi.fn(),
}));
vi.mock('@threadnote/memory/candidate', async original => ({
  ...(await original<typeof import('@threadnote/memory/candidate')>()),
  listCandidateReviews: mocks.list,
  loadCandidateReview: mocks.load,
  withCandidateReviewLock: (_home: string, _reviewId: string, effect: Effect.Effect<unknown, unknown, unknown>) =>
    effect,
}));
vi.mock('../../src/memory/context/maintenance.js', async original => ({
  ...(await original<typeof import('../../src/memory/context/maintenance.js')>()),
  readContextMaintenanceStatus: mocks.status,
  readContextMaintenancePacket: mocks.packet,
}));
vi.mock('../../src/memory/context/maintenance_draft.js', async original => ({
  ...(await original<typeof import('../../src/memory/context/maintenance_draft.js')>()),
  requestTopicMaintenanceDraft: mocks.draft,
}));
vi.mock('../../src/memory/context/maintenance_review.js', async original => ({
  ...(await original<typeof import('../../src/memory/context/maintenance_review.js')>()),
  prepareTopicMaintenanceReview: mocks.preview,
  applyTopicMaintenanceReview: mocks.apply,
  decideTopicMaintenanceReview: mocks.decide,
}));
vi.mock('../../src/mcp/server/memory.js', async original => ({
  ...(await original<typeof import('../../src/mcp/server/memory.js')>()),
  readMemoryRecordsByUri: mocks.records,
}));
vi.mock('../../src/manager/attention.js', async original => ({
  ...(await original<typeof import('../../src/manager/attention.js')>()),
  managerAttentionProjectRoot: mocks.root,
}));
vi.mock('../../src/memory/context/maintenance_topic.js', async original => ({
  ...(await original<typeof import('../../src/memory/context/maintenance_topic.js')>()),
  topicMaintenanceCaseId: () => caseId,
}));

const config = {
  agentContextHome: '/private',
  manifestPath: '/manifest',
  user: 'tester',
  account: 'local',
  agentId: 'threadnote',
} as RuntimeConfig;
const reviewId = `review-${'a'.repeat(24)}`;
const caseId = `health-case-${'b'.repeat(40)}`;
const hash = 'c'.repeat(64);
const targetUri = 'threadnote://user/tester/memories/durable/topic.md';
const review = {
  version: 2,
  reviewId,
  revision: 3,
  project: 'alpha',
  topic: 'topic',
  task: 'task',
  outcome: 'outcome',
  sourceAgentClient: 'threadnote-topic-maintenance',
  createdAt: '2026-10-01T00:00:00.000Z',
  auditEvents: [],
  codeCitations: [],
  candidates: [{candidateId: `${reviewId}-1`, state: 'pending', evidence: ['Advisory warning'], targetUri}],
  maintenance: {
    version: 1,
    basis: {
      version: 1,
      targetUri,
      targetHash: hash,
      observationRevision: hash,
      packetDigest: hash,
      body: 'Accepted body',
      paragraphs: [{ordinal: 1, hash, role: 'descriptive', support: 'direct', citationIds: []}],
      additionalDependencies: [],
      handles: [],
    },
    proposal: {
      version: 1,
      draft: {
        version: 1,
        targetHash: hash,
        observationRevision: hash,
        packetDigest: hash,
        outcome: 'propose-revalidation',
        operations: [],
        reviewedHandles: [],
        rationale: 'Current',
        unresolvedQuestions: [],
        removedClaims: [],
      },
      body: 'Proposed body',
      finalBodyHash: hash,
      changedOrdinals: [],
    },
    reviewEvidence: [],
    generation: {agent: 'local-ai', model: 'gemma', promptVersion: 'test', attempts: 1, usage: {status: 'unavailable'}},
  },
  maintenanceApproval: {
    version: 1,
    reviewRevision: 3,
    stage: 'preview',
    preview: {
      approvalDigest: hash,
      beforeContent: 'PRIVATE BASELINE',
      content: 'FINAL DOCUMENT',
      contentHash: hash,
      beforeContentHash: hash,
      metadataDiff: [{field: 'topicMaintenance', beforeHash: hash, afterHash: hash}],
      codeCitations: [{private: 'pin'}],
    },
  },
} as unknown as CandidateReview;

function call(method: string, route: string, body: Record<string, unknown> = {}) {
  return handleManagerTopicReview({
    config,
    method,
    url: new URL(`http://manager.test${route}`),
    body: Effect.succeed(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockReturnValue(Effect.succeed([review]));
  mocks.load.mockReturnValue(Effect.succeed(review));
  mocks.records.mockReturnValue(Effect.succeed([{uri: targetUri, metadata: {project: 'alpha', memoryId: 'tn_topic'}}]));
  mocks.root.mockReturnValue(Effect.succeed({state: 'available', cwd: '/selected/alpha'}));
  mocks.status.mockReturnValue(
    Effect.succeed({
      cases: [
        {
          caseId,
          project: 'alpha',
          family: 'topic-maintenance',
          slot: 'declared-support',
          subjectUri: targetUri,
          evidenceRevision: hash,
        },
      ],
    }),
  );
  mocks.packet.mockReturnValue(
    Effect.succeed({caseId, project: 'alpha', memoryUri: targetUri, topicEvidence: {outcome: 'ready'}}),
  );
  mocks.draft.mockReturnValue(Effect.succeed(review));
  mocks.preview.mockReturnValue(Effect.succeed(review));
  mocks.apply.mockReturnValue(Effect.succeed(review));
  mocks.decide.mockReturnValue(Effect.succeed(review));
});

describe('Manager topic review adapter', () => {
  effectIt.effect('reads a bounded review without generating, previewing, or writing', () =>
    Effect.gen(function* () {
      const response = yield* call('GET', `/api/attention/topic-review?project=alpha&reviewId=${reviewId}`);
      expect(response?.status).toBe(200);
      const serialized = JSON.stringify(response?.body);
      expect(serialized).toContain('FINAL DOCUMENT');
      expect(serialized).not.toContain('PRIVATE BASELINE');
      expect(serialized).not.toContain('private');
      expect(mocks.draft).not.toHaveBeenCalled();
      expect(mocks.preview).not.toHaveBeenCalled();
      expect(mocks.apply).not.toHaveBeenCalled();
      expect(mocks.root).not.toHaveBeenCalled();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('rejects a different project and closed-field violations before service calls', () =>
    Effect.gen(function* () {
      const foreign = yield* call('GET', `/api/attention/topic-review?project=beta&reviewId=${reviewId}`);
      expect(foreign?.status).toBe(404);
      const malformed = yield* call('POST', '/api/attention/topic-review', {
        action: 'preview',
        project: 'alpha',
        reviewId,
        revision: 3,
        sourceCwd: '/wrong',
      });
      expect(malformed?.status).toBe(400);
      const unsupported = yield* call('POST', '/api/attention/topic-review', {
        action: 'generate',
        project: 'alpha',
        caseId,
        backend: 'codex',
        modelId: 'model',
      });
      expect(unsupported?.status).toBe(400);
      expect(mocks.preview).not.toHaveBeenCalled();
      expect(mocks.draft).not.toHaveBeenCalled();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('echoes exact edited preview and digest through selected project root', () =>
    Effect.gen(function* () {
      const body = {action: 'preview', project: 'alpha', reviewId, revision: 3, editedDraftJson: '{}'};
      const preview = yield* call('POST', '/api/attention/topic-review', body);
      expect(preview?.status).toBe(200);
      expect(mocks.preview).toHaveBeenCalledWith(config, {
        reviewId,
        revision: 3,
        editedDraftJson: '{}',
        sourceCwd: '/selected/alpha',
      });
      const applied = yield* call('POST', '/api/attention/topic-review', {
        action: 'apply',
        project: 'alpha',
        reviewId,
        revision: 3,
        approvalDigest: hash,
        approved: true,
      });
      expect(applied?.status).toBe(200);
      expect(mocks.apply).toHaveBeenCalledWith(config, {
        reviewId,
        revision: 3,
        sourceCwd: '/selected/alpha',
        approvalDigest: hash,
        approved: true,
      });
      expect((applied?.body as {approval?: {approvalDigest: string}} | undefined)?.approval?.approvalDigest).toBe(hash);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('generates only from the selected ready case and chosen backend/model', () =>
    Effect.gen(function* () {
      const generated = yield* call('POST', '/api/attention/topic-review', {
        action: 'generate',
        project: 'alpha',
        caseId,
        backend: 'local-ai',
        modelId: 'gemma',
      });
      expect(generated?.status).toBe(200);
      expect(mocks.draft).toHaveBeenCalledWith(config, {
        caseId,
        backend: 'local-ai',
        modelId: 'gemma',
        regenerate: false,
      });
      mocks.packet.mockReturnValueOnce(
        Effect.succeed({caseId, project: 'beta', memoryUri: targetUri, topicEvidence: {outcome: 'ready'}}),
      );
      const foreign = yield* call('POST', '/api/attention/topic-review', {
        action: 'regenerate',
        project: 'alpha',
        caseId,
        backend: 'effect-ai',
        modelId: 'configured',
      });
      expect(foreign?.status).toBe(409);
      expect(mocks.draft).toHaveBeenCalledTimes(1);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('routes decisions through the persisted review and exact case', () =>
    Effect.gen(function* () {
      const decided = yield* call('POST', '/api/attention/topic-review', {
        action: 'defer',
        project: 'alpha',
        reviewId,
        revision: 3,
        caseId,
      });
      expect(decided?.status).toBe(200);
      expect(mocks.decide).toHaveBeenCalledWith(config, {reviewId, revision: 3, action: 'defer', caseId});
      const stale = yield* call('POST', '/api/attention/topic-review', {
        action: 'resume',
        project: 'alpha',
        reviewId,
        revision: 3,
        caseId: `health-case-${'e'.repeat(40)}`,
      });
      expect(stale?.status).toBe(409);
      expect(mocks.decide).toHaveBeenCalledTimes(1);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('recovers a persisted resume after a transient reconciliation failure', () =>
    Effect.gen(function* () {
      const deferred = {
        ...review,
        candidates: [{...review.candidates[0], state: 'deferred' as const}],
      };
      const resumed = {
        ...deferred,
        revision: 4,
        candidates: [{...review.candidates[0], state: 'pending' as const}],
        auditEvents: [{action: 'resume' as const, revision: 4}],
      };
      mocks.load.mockReturnValueOnce(Effect.succeed(deferred)).mockReturnValue(Effect.succeed(resumed));
      mocks.decide
        .mockReturnValueOnce(Effect.fail(TopicReviewError.make({message: 'reconcile interrupted'})))
        .mockReturnValue(Effect.succeed(resumed));
      const response = yield* call('POST', '/api/attention/topic-review', {
        action: 'resume',
        project: 'alpha',
        reviewId,
        revision: 3,
        caseId,
      });
      expect(response?.status).toBe(200);
      expect(response?.body).toMatchObject({state: 'pending', revision: 4});
      expect(mocks.decide).toHaveBeenCalledTimes(2);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('requires reload after a failed replay without projecting cached state as current', () =>
    Effect.gen(function* () {
      const deferred = {
        ...review,
        candidates: [{...review.candidates[0], state: 'deferred' as const}],
      };
      const resumed = {
        ...deferred,
        revision: 4,
        candidates: [{...review.candidates[0], state: 'pending' as const}],
        auditEvents: [{action: 'resume' as const, revision: 4}],
      };
      mocks.load.mockReturnValueOnce(Effect.succeed(deferred)).mockReturnValue(Effect.succeed(resumed));
      mocks.decide.mockReturnValue(Effect.fail(TopicReviewError.make({message: 'reconcile unavailable'})));
      const response = yield* call('POST', '/api/attention/topic-review', {
        action: 'resume',
        project: 'alpha',
        reviewId,
        revision: 3,
        caseId,
      });
      expect(response?.status).toBe(409);
      expect(response?.body).toMatchObject({
        code: 'topic-review-decision-reload-required',
      });
      expect(response?.body).not.toHaveProperty('review');
      expect(mocks.decide).toHaveBeenCalledTimes(2);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'keeps prepared recovery callable with its retained approval revision after review revision advances',
    () =>
      Effect.gen(function* () {
        const prepared = {
          ...review,
          revision: 4,
          candidates: [{...review.candidates[0], state: 'applying' as const}],
          maintenanceApproval: {...review.maintenanceApproval!, stage: 'prepared' as const},
        };
        mocks.load.mockReturnValue(Effect.succeed(prepared));
        mocks.list.mockReturnValue(Effect.succeed([prepared]));
        mocks.records.mockReturnValue(Effect.succeed([]));
        const read = yield* call('GET', `/api/attention/topic-review?project=alpha&reviewId=${reviewId}`);
        expect(read?.body).toMatchObject({
          revision: 4,
          state: 'applying',
          canApply: true,
          approval: {stage: 'prepared', reviewRevision: 3, approvalDigest: hash},
        });
        const retry = yield* call('POST', '/api/attention/topic-review', {
          action: 'apply',
          project: 'alpha',
          reviewId,
          revision: 3,
          approvalDigest: hash,
          approved: true,
        });
        expect(retry?.status).toBe(200);
        expect(mocks.apply).toHaveBeenCalledWith(config, {
          reviewId,
          revision: 3,
          sourceCwd: '/selected/alpha',
          approvalDigest: hash,
          approved: true,
        });
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('permits old-evidence reject and defer for the same case, including conflict closure', () =>
    Effect.gen(function* () {
      const newer = 'd'.repeat(64);
      mocks.status.mockReturnValue(
        Effect.succeed({
          cases: [
            {
              caseId,
              project: 'alpha',
              family: 'topic-maintenance',
              slot: 'declared-support',
              subjectUri: targetUri,
              evidenceRevision: newer,
            },
          ],
        }),
      );
      const deferred = yield* call('POST', '/api/attention/topic-review', {
        action: 'defer',
        project: 'alpha',
        reviewId,
        revision: 3,
        caseId,
      });
      expect(deferred?.status).toBe(200);
      expect(mocks.decide).toHaveBeenCalledWith(config, {reviewId, revision: 3, action: 'defer', caseId});
      const conflicted = {
        ...review,
        revision: 4,
        candidates: [{...review.candidates[0], state: 'conflict' as const}],
        maintenanceApproval: {...review.maintenanceApproval!, stage: 'conflict' as const},
      };
      mocks.load.mockReturnValue(Effect.succeed(conflicted));
      const closed = yield* call('POST', '/api/attention/topic-review', {
        action: 'reject',
        project: 'alpha',
        reviewId,
        revision: 4,
        caseId,
      });
      expect(closed?.status).toBe(200);
      expect(mocks.decide).toHaveBeenCalledWith(config, {reviewId, revision: 4, action: 'reject', caseId});
      const resumed = yield* call('POST', '/api/attention/topic-review', {
        action: 'resume',
        project: 'alpha',
        reviewId,
        revision: 4,
        caseId,
      });
      expect(resumed?.status).toBe(409);
      expect(mocks.root).not.toHaveBeenCalled();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'reads a stale inbox review with stable case identity for closeout but blocks preview and acceptance',
    () =>
      Effect.gen(function* () {
        mocks.status.mockReturnValue(
          Effect.succeed({
            cases: [
              {
                caseId,
                project: 'alpha',
                family: 'topic-maintenance',
                slot: 'declared-support',
                subjectUri: targetUri,
                evidenceRevision: 'd'.repeat(64),
              },
            ],
          }),
        );
        const inbox = yield* call('GET', `/api/attention/topic-review?project=alpha&reviewId=${reviewId}`);
        expect(inbox?.status).toBe(200);
        expect(inbox?.body).toMatchObject({caseId, caseObservationMatches: false, canApply: false});
        const projectedCaseId = (inbox!.body as {caseId: string}).caseId;
        const deferred = yield* call('POST', '/api/attention/topic-review', {
          action: 'defer',
          project: 'alpha',
          reviewId,
          revision: 3,
          caseId: projectedCaseId,
        });
        expect(deferred?.status).toBe(200);
        const rejected = yield* call('POST', '/api/attention/topic-review', {
          action: 'reject',
          project: 'alpha',
          reviewId,
          revision: 3,
          caseId: projectedCaseId,
        });
        expect(rejected?.status).toBe(200);
        const stalePreview = yield* call('POST', '/api/attention/topic-review', {
          action: 'preview',
          project: 'alpha',
          reviewId,
          revision: 3,
        });
        expect(stalePreview?.status).toBe(409);
        const staleApply = yield* call('POST', '/api/attention/topic-review', {
          action: 'apply',
          project: 'alpha',
          reviewId,
          revision: 3,
          approvalDigest: hash,
          approved: true,
        });
        expect(staleApply?.status).toBe(409);
        expect(mocks.preview).not.toHaveBeenCalled();
        expect(mocks.apply).not.toHaveBeenCalled();
        const conflicted = {
          ...review,
          revision: 4,
          candidates: [{...review.candidates[0], state: 'conflict' as const}],
          maintenanceApproval: {...review.maintenanceApproval!, stage: 'conflict' as const},
        };
        mocks.list.mockReturnValue(Effect.succeed([conflicted]));
        mocks.load.mockReturnValue(Effect.succeed(conflicted));
        const conflictInbox = yield* call('GET', `/api/attention/topic-review?project=alpha&reviewId=${reviewId}`);
        expect(conflictInbox?.body).toMatchObject({caseId, caseObservationMatches: false, canApply: false});
        const closed = yield* call('POST', '/api/attention/topic-review', {
          action: 'reject',
          project: 'alpha',
          reviewId,
          revision: 4,
          caseId: (conflictInbox!.body as {caseId: string}).caseId,
        });
        expect(closed?.status).toBe(200);
        expect(mocks.decide).toHaveBeenCalledWith(config, {reviewId, revision: 4, action: 'reject', caseId});
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('guards generic review preview and decision for maintenance reviews', () =>
    Effect.gen(function* () {
      for (const route of ['/api/reviews/preview', '/api/reviews/refresh-safety', '/api/reviews/decide']) {
        const response = yield* handleManagerAttentionAction({
          config,
          method: 'POST',
          url: new URL(`http://manager.test${route}`),
          body: Effect.succeed({
            project: 'alpha',
            reviewId,
            revision: 3,
            candidateId: `${reviewId}-1`,
            action: 'approve',
            approved: true,
          }),
        });
        expect(response?.status).toBe(409);
        expect(response?.body).toMatchObject({code: 'topic-review-route-required'});
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
});

describe('topic projection invariant', () => {
  effectIt.effect('projects the persisted approved proposal while preserving the generated draft', () =>
    Effect.sync(() => {
      const editedDraft = {
        ...review.maintenance!.proposal.draft,
        rationale: 'First edit',
        unresolvedQuestions: ['Second edit'],
      };
      const approvedProposal = {
        ...review.maintenance!.proposal,
        draft: editedDraft,
        body: 'Approved edited body',
        finalBodyHash: 'e'.repeat(64),
        changedOrdinals: [0],
      };
      const withApproval = {
        ...review,
        maintenanceApproval: {
          ...review.maintenanceApproval!,
          preview: {...review.maintenanceApproval!.preview, approvedProposal},
        },
      };
      const projected = projectManagerTopicReview(withApproval, {caseId, observationMatches: true})!;
      expect(projected.draft).toEqual(editedDraft);
      expect(projected.proposal).toMatchObject({
        body: 'Approved edited body',
        finalBodyHash: 'e'.repeat(64),
        changedOrdinals: [0],
      });
      expect(review.maintenance!.proposal.draft.rationale).toBe('Current');
      expect(JSON.stringify(projected)).not.toContain('PRIVATE BASELINE');
    }),
  );
  effectIt.effect('omits arbitrary private before-content and source pins at every approval stage', () =>
    Effect.sync(() => {
      fc.assert(
        fc.property(
          fc.constantFrom('preview', 'prepared', 'written', 'conflict' as const),
          fc.string({maxLength: 40}),
          (stage, suffix) => {
            const privateBaseline = `PRIVATE_BASELINE_${suffix}`;
            const value = projectManagerTopicReview({
              ...review,
              maintenanceApproval: {
                ...review.maintenanceApproval!,
                stage,
                preview: {...review.maintenanceApproval!.preview, beforeContent: privateBaseline},
              },
            })!;
            const serialized = JSON.stringify(value);
            expect(serialized).not.toContain(privateBaseline);
            expect(serialized).not.toContain('codeCitations');
            expect(value.approval?.stage).toBe(stage);
          },
        ),
        {numRuns: 32},
      );
    }),
  );
});
