import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import fc from 'fast-check';
import {beforeEach, describe, expect, vi} from 'vitest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {CandidateReview} from '@threadnote/memory/candidate';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {handleManagerTopicReview, projectManagerTopicReview} from '../../src/manager/topic_review.js';
import {TopicDraftError} from '../../src/memory/context/maintenance_draft.js';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {TopicReviewError} from '../../src/memory/context/maintenance_review.js';
import {handleManagerAttentionAction} from '../../src/manager/attention_actions.js';
import {handleManagerAttentionRequest} from '../../src/manager/attention.js';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {canonicalMemoryDocumentContent, formatMemoryDocument, parseMemoryDocument} from '@threadnote/memory/document';
import {proposeTopicMaintenanceEnrollment} from '@threadnote/memory/topic-maintenance';
import {maintenanceContentHash} from '../../src/memory/context/maintenance_policy.js';

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
  read: vi.fn(),
  capture: vi.fn(),
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
  readTopicMaintenanceDraft: mocks.read,
}));
vi.mock('../../src/memory/context/maintenance_obsidian.js', () => ({captureTopicObsidianEvidence: mocks.capture}));
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
        paragraphDispositions: {
          version: 1,
          entries: [
            {
              ordinal: 1,
              beforeHash: hash,
              disposition: 'revalidate',
              supportHandles: [`current:tncc_${'a'.repeat(40)}`],
              rationale: 'Checked.',
            },
          ],
        },
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
          memoryId: 'tn_topic',
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
  mocks.read.mockReturnValue(Effect.succeed(review));
  mocks.capture.mockReturnValue(Effect.succeed(review));
});

describe('Manager topic review adapter', () => {
  effectIt.effect('finds only a persisted stale written review by exact case selector after packet refusal', () =>
    Effect.gen(function* () {
      const exactId = `review-${sha256HexSync(`topic-maintenance\0${targetUri}`).slice(0, 24)}`;
      const oldHash = maintenanceContentHash('PRIVATE BASELINE');
      const savedHash = maintenanceContentHash('FINAL DOCUMENT');
      const written = {
        ...review,
        reviewId: exactId,
        candidates: [{...review.candidates[0], state: 'applied' as const}],
        maintenance: {...review.maintenance!, basis: {...review.maintenance!.basis, targetHash: oldHash}},
        maintenanceApproval: {
          ...review.maintenanceApproval!,
          stage: 'written' as const,
          preview: {
            ...review.maintenanceApproval!.preview,
            reviewId: exactId,
            targetUri,
            beforeContentHash: oldHash,
            contentHash: savedHash,
          },
        },
      } as CandidateReview;
      mocks.list.mockReturnValue(Effect.succeed([written]));
      mocks.load.mockReturnValue(Effect.succeed(written));
      mocks.records.mockReturnValue(
        Effect.succeed([
          {uri: targetUri, metadata: {project: 'alpha', memoryId: 'tn_topic'}, content: 'FINAL DOCUMENT'},
        ]),
      );
      const staleCase = {
        caseId,
        project: 'alpha',
        memoryId: 'tn_topic',
        family: 'topic-maintenance',
        slot: 'declared-support',
        subjectUri: targetUri,
        evidenceRevision: hash,
        subjectContentHashes: [{uri: targetUri, hash: oldHash}],
      };
      mocks.status.mockReturnValue(Effect.succeed({cases: [staleCase]}));
      mocks.packet.mockReturnValue(Effect.fail(TopicReviewError.make({message: 'Stale packet.'})));
      const result = yield* call('GET', `/api/attention/topic-review?project=alpha&caseId=${caseId}`);
      expect(result?.status).toBe(200);
      expect(result?.body).toMatchObject({reviewId: exactId, canFinishVerification: true});
      expect(mocks.packet).not.toHaveBeenCalled();
      for (const query of [
        `project=alpha&caseId=${caseId}&reviewId=${exactId}`,
        `project=alpha&caseId=${caseId}&unknown=1`,
        `project=alpha&caseId=${caseId}&caseId=${caseId}`,
      ])
        expect((yield* call('GET', `/api/attention/topic-review?${query}`))?.status).toBe(400);
      for (const changed of [
        {...staleCase, project: 'beta'},
        {...staleCase, memoryId: 'other'},
        {...staleCase, slot: 'other'},
        {...staleCase, subjectUri: `${targetUri}-other`},
        {...staleCase, evidenceRevision: 'd'.repeat(64)},
        {...staleCase, subjectContentHashes: [{uri: targetUri, hash: 'd'.repeat(64)}]},
      ]) {
        mocks.status.mockReturnValue(Effect.succeed({cases: [changed]}));
        expect((yield* call('GET', `/api/attention/topic-review?project=alpha&caseId=${caseId}`))?.status).toBe(404);
      }
      mocks.status.mockReturnValue(Effect.succeed({cases: [staleCase]}));
      mocks.records.mockReturnValue(
        Effect.succeed([
          {uri: targetUri, metadata: {project: 'alpha', memoryId: 'tn_topic'}, content: 'NEWER DOCUMENT'},
        ]),
      );
      expect((yield* call('GET', `/api/attention/topic-review?project=alpha&caseId=${caseId}`))?.status).toBe(404);
      mocks.records.mockReturnValue(
        Effect.succeed([
          {uri: targetUri, metadata: {project: 'alpha', memoryId: 'tn_topic'}, content: 'FINAL DOCUMENT'},
        ]),
      );
      mocks.load.mockReturnValue(
        Effect.succeed({
          ...written,
          maintenanceApproval: {
            ...written.maintenanceApproval!,
            preview: {
              ...written.maintenanceApproval!.preview,
              reviewId: reviewId,
            },
          },
        }),
      );
      expect((yield* call('GET', `/api/attention/topic-review?project=alpha&caseId=${caseId}`))?.status).toBe(404);
      const imported = {...written, maintenance: {...written.maintenance!, version: 2 as const}} as CandidateReview;
      mocks.load.mockReturnValue(Effect.succeed(imported));
      mocks.read.mockReturnValue(Effect.fail(TopicReviewError.make({message: 'Imported access expired.'})));
      expect((yield* call('GET', `/api/attention/topic-review?project=alpha&caseId=${caseId}`))?.status).toBe(404);
      mocks.read
        .mockReturnValueOnce(Effect.succeed(imported))
        .mockReturnValueOnce(Effect.fail(TopicReviewError.make({message: 'Imported access expired.'})));
      expect((yield* call('GET', `/api/attention/topic-review?project=alpha&caseId=${caseId}`))?.status).toBe(404);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );
  effectIt.effect('keeps a spaced project name through read, generation, preview and approval', () =>
    Effect.gen(function* () {
      const project = 'Example Project';
      const selected = {...review, project};
      mocks.list.mockReturnValue(Effect.succeed([selected]));
      for (const mock of [mocks.load, mocks.read, mocks.draft, mocks.preview, mocks.apply])
        mock.mockReturnValue(Effect.succeed(selected));
      mocks.records.mockReturnValue(Effect.succeed([{uri: targetUri, metadata: {project, memoryId: 'tn_topic'}}]));
      mocks.status.mockReturnValue(
        Effect.succeed({
          cases: [
            {
              caseId,
              project,
              memoryId: 'tn_topic',
              family: 'topic-maintenance',
              slot: 'declared-support',
              subjectUri: targetUri,
              evidenceRevision: hash,
            },
          ],
        }),
      );
      mocks.packet.mockReturnValue(
        Effect.succeed({caseId, project, memoryUri: targetUri, topicEvidence: {outcome: 'ready'}}),
      );
      expect(
        (yield* call('GET', `/api/attention/topic-review?project=${encodeURIComponent(project)}&reviewId=${reviewId}`))
          ?.status,
      ).toBe(200);
      expect(
        (yield* call('POST', '/api/attention/topic-review', {
          action: 'generate',
          project,
          caseId,
          backend: 'local-ai',
          modelId: 'synthetic-model',
        }))?.status,
      ).toBe(200);
      expect(
        (yield* call('POST', '/api/attention/topic-review', {
          action: 'preview',
          project,
          reviewId,
          revision: 3,
        }))?.status,
      ).toBe(200);
      expect(
        (yield* call('POST', '/api/attention/topic-review', {
          action: 'apply',
          project,
          reviewId,
          revision: 3,
          approvalDigest: hash,
          approved: true,
        }))?.status,
      ).toBe(200);
      expect(mocks.root).toHaveBeenCalledWith(config, project);
      expect(mocks.apply).toHaveBeenCalledWith(config, {
        reviewId,
        revision: 3,
        sourceCwd: '/selected/alpha',
        approvalDigest: hash,
        approved: true,
      });
      expect(
        (yield* call('POST', '/api/attention/topic-review', {
          action: 'apply',
          project: 'Example-Project',
          reviewId,
          revision: 3,
          approvalDigest: hash,
          approved: true,
        }))?.status,
      ).toBe(404);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  const importedReview = () =>
    ({
      ...review,
      maintenance: {...review.maintenance!, version: 2, sourceKind: 'obsidian'},
    }) as unknown as CandidateReview;

  effectIt.effect('reauthorizes imported review text and skips checkout selection for preview and apply', () =>
    Effect.gen(function* () {
      const imported = importedReview();
      mocks.list.mockReturnValue(Effect.succeed([imported]));
      mocks.load.mockReturnValue(Effect.succeed(imported));
      mocks.read.mockReturnValue(Effect.succeed(imported));
      mocks.preview.mockReturnValue(Effect.succeed(imported));
      mocks.apply.mockReturnValue(Effect.succeed(imported));
      const result = yield* call('GET', `/api/attention/topic-review?project=alpha&reviewId=${reviewId}`);
      expect(result?.status).toBe(200);
      expect(mocks.read).toHaveBeenCalledWith(config, reviewId);
      const prepared = yield* call('POST', '/api/attention/topic-review', {
        action: 'preview',
        project: 'alpha',
        reviewId,
        revision: 3,
      });
      expect(prepared?.status).toBe(200);
      expect(mocks.preview).toHaveBeenCalledWith(config, {reviewId, revision: 3});
      const applied = yield* call('POST', '/api/attention/topic-review', {
        action: 'apply',
        project: 'alpha',
        reviewId,
        revision: 3,
        approvalDigest: hash,
        approved: true,
      });
      expect(applied?.status).toBe(200);
      expect(mocks.apply).toHaveBeenCalledWith(config, {reviewId, revision: 3, approvalDigest: hash, approved: true});
      expect(mocks.root).not.toHaveBeenCalled();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('withholds accepted, proposed and approved imported text after access is revoked', () =>
    Effect.gen(function* () {
      const imported = importedReview();
      mocks.list.mockReturnValue(Effect.succeed([imported]));
      mocks.load.mockReturnValue(Effect.succeed(imported));
      mocks.read.mockReturnValue(Effect.fail(TopicReviewError.make({message: 'source denied'})));
      const result = yield* call('GET', `/api/attention/topic-review?project=alpha&reviewId=${reviewId}`);
      expect(result?.status).toBe(200);
      expect(result?.body).toMatchObject({
        kind: 'topic-maintenance-recovery',
        reviewId,
        revision: 3,
        caseId,
        recovery: {action: 'reject'},
      });
      expect(JSON.stringify(result?.body)).not.toMatch(/Accepted body|Proposed body|FINAL DOCUMENT|PRIVATE BASELINE/u);
      const action = yield* call('POST', '/api/attention/topic-review', {
        action: 'preview',
        project: 'alpha',
        reviewId,
        revision: 3,
      });
      expect(action?.status).toBe(404);
      expect(mocks.preview).not.toHaveBeenCalled();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('retains a generic inbox entry while withholding every imported text field after revocation', () =>
    Effect.gen(function* () {
      const imported = importedReview();
      const privateEntry = {
        ...imported,
        topic: 'PRIVATE_TOPIC',
        task: 'PRIVATE_TASK',
        candidates: [{...imported.candidates[0], proposedText: 'PRIVATE_PROPOSAL', reason: 'PRIVATE_REASON'}],
      } as CandidateReview;
      mocks.list.mockReturnValue(Effect.succeed([privateEntry]));
      mocks.read.mockReturnValue(Effect.fail(TopicReviewError.make({message: 'source denied'})));
      const result = yield* handleManagerAttentionRequest({
        config,
        method: 'GET',
        url: new URL('http://manager.test/api/reviews?project=alpha'),
      });
      expect(result?.status).toBe(200);
      expect(JSON.stringify(result?.body)).not.toMatch(/PRIVATE_|topic\.md|Accepted body|FINAL DOCUMENT/u);
      expect(result?.body).toMatchObject({
        pendingCount: 1,
        items: [{reviewId, revision: 3, topic: 'Private topic update', candidates: [{proposedText: ''}]}],
      });
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('checks current source access only for imported reviews in the requested inbox view', () =>
    Effect.gen(function* () {
      const pending = importedReview();
      const deferred = {
        ...pending,
        reviewId: `review-${'b'.repeat(24)}`,
        candidates: [{...pending.candidates[0], state: 'deferred' as const}],
      } as CandidateReview;
      const history = {
        ...pending,
        reviewId: `review-${'c'.repeat(24)}`,
        candidates: [{...pending.candidates[0], state: 'rejected' as const}],
      } as CandidateReview;
      mocks.list.mockReturnValue(Effect.succeed([pending, deferred, history]));
      mocks.read.mockImplementation((_config: RuntimeConfig, id: string) =>
        id === pending.reviewId
          ? Effect.succeed(pending)
          : Effect.fail(TopicReviewError.make({message: 'unrelated source must not be read'})),
      );
      const result = yield* handleManagerAttentionRequest({
        config,
        method: 'GET',
        url: new URL('http://manager.test/api/reviews?project=alpha&view=pending'),
      });
      expect(result?.body).toMatchObject({pendingCount: 2, items: [{reviewId: pending.reviewId}]});
      expect(mocks.read).toHaveBeenCalledTimes(1);
      expect(mocks.read).toHaveBeenCalledWith(config, pending.reviewId);
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('keeps capture-only journals out of inboxes and every generic review response', () =>
    Effect.gen(function* () {
      const {maintenance: _maintenance, maintenanceApproval: _approval, ...base} = review;
      const journal = {
        ...base,
        maintenanceCapture: {input: {fragment: 'PRIVATE_CAPTURE'}},
      } as unknown as CandidateReview;
      mocks.list.mockReturnValue(Effect.succeed([journal]));
      mocks.load.mockReturnValue(Effect.succeed(journal));
      const inbox = yield* handleManagerAttentionRequest({
        config,
        method: 'GET',
        url: new URL('http://manager.test/api/reviews?project=alpha'),
      });
      expect(inbox?.body).toMatchObject({pendingCount: 0, items: []});
      for (const route of ['/api/reviews/preview', '/api/reviews/decide', '/api/reviews/refresh-safety']) {
        const result = yield* handleManagerAttentionAction({
          config,
          method: 'POST',
          url: new URL(`http://manager.test${route}`),
          body: Effect.succeed({project: 'alpha', reviewId, revision: 3, candidateId: `${reviewId}-1`}),
        });
        expect(result?.status).toBe(409);
        expect(JSON.stringify(result?.body)).not.toContain('PRIVATE_CAPTURE');
      }
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('captures only explicitly approved exact imported selections before generation', () =>
    Effect.gen(function* () {
      mocks.packet.mockReturnValue(
        Effect.succeed({
          caseId,
          project: 'alpha',
          memoryUri: targetUri,
          topicEvidence: {version: 2, sourceKind: 'obsidian', outcome: 'ready'},
        }),
      );
      const action = {
        action: 'capture',
        project: 'alpha',
        caseId,
        expectedContentHash: hash,
        observationRevision: hash,
        inspectionDigest: hash,
        fragmentStart: 2,
        fragmentEnd: 18,
        retentionDays: 30,
        approved: true,
      };
      expect((yield* call('POST', '/api/attention/topic-review', {...action, approved: false}))?.status).toBe(400);
      expect(mocks.capture).not.toHaveBeenCalled();
      expect((yield* call('POST', '/api/attention/topic-review', action))?.status).toBe(200);
      const {action: _action, project: _project, ...input} = action;
      expect(mocks.capture).toHaveBeenCalledWith(config, input);
      expect(mocks.draft).not.toHaveBeenCalled();
      expect(mocks.root).not.toHaveBeenCalled();
    }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('never projects arbitrary imported text without exact current access authorization', () =>
    Effect.sync(() =>
      fc.assert(
        fc.property(fc.string({minLength: 1, maxLength: 200}), text => {
          const imported = importedReview();
          const payload = {
            ...imported,
            topic: text,
            maintenance: {...imported.maintenance!, basis: {...imported.maintenance!.basis, body: text}},
          } as CandidateReview;
          expect(projectManagerTopicReview(payload, {caseId, observationMatches: true})).toBeUndefined();
          expect(
            projectManagerTopicReview(payload, {
              caseId,
              observationMatches: true,
              importedAccess: {reviewId, revision: payload.revision + 1},
            }),
          ).toBeUndefined();
        }),
        {numRuns: 30},
      ),
    ),
  );

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

  effectIt.effect(
    'offers final verification for a legacy prepared review only after exact approved-byte readback',
    () =>
      Effect.gen(function* () {
        const payload = review.maintenance;
        if (payload?.version !== 1) throw new Error('Expected the frozen legacy code review.');
        const {paragraphDispositions: _accounting, ...legacyDraft} = payload.proposal.draft;
        const legacy = {
          ...review,
          revision: 4,
          candidates: [{...review.candidates[0], state: 'applying' as const}],
          maintenance: {...payload, proposal: {...payload.proposal, draft: legacyDraft}},
          maintenanceApproval: {...review.maintenanceApproval!, stage: 'prepared' as const},
        };
        mocks.list.mockReturnValue(Effect.succeed([legacy]));
        const read = () => call('GET', `/api/attention/topic-review?project=alpha&reviewId=${reviewId}`);
        for (const content of ['Accepted body', 'OTHER DOCUMENT', legacy.maintenanceApproval.preview.content]) {
          mocks.records.mockReturnValue(
            Effect.succeed([{uri: targetUri, metadata: {project: 'alpha', memoryId: 'tn_topic'}, content}]),
          );
          const response = yield* read();
          expect(response?.body).toMatchObject({
            state: 'applying',
            canApply: false,
            canFinishVerification: content === legacy.maintenanceApproval.preview.content,
            paragraphCoverage: {status: 'legacy'},
          });
        }
      }).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect(
    'returns bounded exact-review recovery only after validating review identity, target and project',
    () =>
      Effect.gen(function* () {
        const exactId = `review-${sha256HexSync(`topic-maintenance\0${targetUri}`).slice(0, 24)}`;
        const blocked = {
          ...review,
          reviewId: exactId,
          candidates: [{...review.candidates[0], state: 'conflict' as const}],
        };
        mocks.draft.mockReturnValue(
          Effect.fail(
            TopicDraftError.make({
              message: 'PRIVATE RAW FAILURE',
              reason: 'review-conflict',
              recovery: {reviewId: exactId, state: 'conflict'},
            }),
          ),
        );
        mocks.load.mockReturnValue(Effect.succeed(blocked));
        const request = () =>
          call('POST', '/api/attention/topic-review', {
            action: 'generate',
            project: 'alpha',
            caseId,
            backend: 'local-ai',
            modelId: 'gemma',
          });
        const response = yield* request();
        expect(response?.status).toBe(409);
        expect(response?.body).toMatchObject({
          code: 'topic-draft-review-blocked',
          reason: 'review-conflict',
          recovery: {action: 'open-review', reviewId: exactId, state: 'conflict'},
        });
        expect(JSON.stringify(response?.body)).not.toContain('PRIVATE RAW FAILURE');
        for (const invalid of [
          {...blocked, project: 'other'},
          {...blocked, reviewId},
          {...blocked, candidates: [{...blocked.candidates[0], state: 'pending' as const}]},
          {
            ...blocked,
            maintenance: {
              ...blocked.maintenance!,
              basis: {...blocked.maintenance!.basis, targetUri: targetUri + '-other'},
            },
          },
        ]) {
          mocks.load.mockReturnValue(Effect.succeed(invalid));
          const refused = yield* request();
          expect(refused?.body).toMatchObject({code: 'topic-draft-unavailable'});
          expect(refused?.body).not.toHaveProperty('recovery');
        }
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
                memoryId: 'tn_topic',
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
  effectIt.effect(
    'projects only old accepted slots whose reviewed current citation is active after the written approval',
    () =>
      Effect.sync(() => {
        const receiptUri = 'threadnote://user/tester/memories/durable/projects/alpha/topic.md';
        const citation = (value: string) =>
          createMemoryCodeCitation({
            version: 1,
            evidenceRetention: 'capsule-retained',
            repositoryId: '1'.repeat(64),
            repositoryIdentityKind: 'local',
            sourceCommit: '2'.repeat(40),
            sourceSnapshotId: `cgsn_${'3'.repeat(40)}`,
            sourceDirty: false,
            extractorSet: 'test',
            path: 'source.ts',
            fileContentHash: {algorithm: 'sha256', value: value.repeat(64)},
            target: {kind: 'file'},
          });
        const origin = citation('4');
        const previous = citation('5');
        const current = citation('6');
        const base = parseMemoryDocument(
          receiptUri,
          formatMemoryDocument(
            'MEMORY',
            {
              kind: 'durable',
              status: 'active',
              project: 'alpha',
              memoryId: 'tn_projection',
              schemaVersion: 9,
              sourceAgentClient: 'test',
              timestamp: '2026-10-01T00:00:00.000Z',
              codeCitations: [origin],
            },
            'Accepted body',
          ),
        )!;
        const enrolled = parseMemoryDocument(
          receiptUri,
          proposeTopicMaintenanceEnrollment(base, {
            paragraphs: [{role: 'descriptive', support: 'direct', citationIds: [origin.id]}],
          }).content,
        )!;
        const manifest = enrolled.metadata.topicMaintenance;
        if (manifest?.version !== 1) throw new Error('Expected a code enrollment fixture.');
        const content = (acceptedCitationId: string) =>
          formatMemoryDocument(
            'MEMORY',
            {
              ...enrolled.metadata,
              codeCitations: [origin, previous, current],
              topicMaintenance: {
                ...manifest,
                version: 2,
                originCitationIds: [origin.id],
                acceptedSources: [{citationId: origin.id, acceptedCitationId}],
              },
            },
            enrolled.body,
          );
        const beforeContent = content(previous.id);
        const afterContent = content(current.id);
        const contentHash = (value: string) => sha256HexSync(canonicalMemoryDocumentContent(value));
        const fixture = {
          ...review,
          candidates: [{...review.candidates[0], state: 'applied'}],
          maintenance: {
            ...review.maintenance!,
            basis: {
              ...review.maintenance!.basis,
              targetUri: receiptUri,
              targetHash: contentHash(beforeContent),
              handles: [{id: `current:${origin.id}`, citationId: origin.id, variant: 'current'}],
            },
            reviewEvidence: [
              {
                handleId: `current:${origin.id}`,
                citation: current,
                source: {path: current.path},
                provenance: 'current-verified',
                supportsCitation: true,
                truncated: false,
              },
            ],
          },
          maintenanceApproval: {
            ...review.maintenanceApproval!,
            stage: 'written',
            preview: {
              ...review.maintenanceApproval!.preview,
              targetUri: receiptUri,
              beforeContent,
              beforeContentHash: contentHash(beforeContent),
              content: afterContent,
              contentHash: contentHash(afterContent),
            },
          },
        } as unknown as CandidateReview;
        const value = projectManagerTopicReview(fixture)!;
        expect(value.resolvedCitationIds).toEqual([previous.id]);
        expect(JSON.stringify(value)).not.toContain(beforeContent);
        const retainedOnly = {
          ...fixture,
          maintenanceApproval: {
            ...fixture.maintenanceApproval!,
            preview: {
              ...fixture.maintenanceApproval!.preview,
              content: beforeContent,
              contentHash: contentHash(beforeContent),
            },
          },
        } as CandidateReview;
        expect(projectManagerTopicReview(retainedOnly)!.resolvedCitationIds).toEqual([]);
        const malformed = {
          ...fixture,
          maintenanceApproval: {
            ...fixture.maintenanceApproval!,
            preview: {...fixture.maintenanceApproval!.preview, beforeContent: 'unavailable'},
          },
        } as CandidateReview;
        expect(projectManagerTopicReview(malformed)!.resolvedCitationIds).toBeUndefined();
        const unwritten = {
          ...fixture,
          candidates: [{...fixture.candidates[0], state: 'applying' as const}],
        } as CandidateReview;
        expect(projectManagerTopicReview(unwritten)!.resolvedCitationIds).toBeUndefined();
      }),
  );
  effectIt.effect('projects the persisted approved proposal while preserving the generated draft', () =>
    Effect.sync(() => {
      const payload = review.maintenance;
      if (payload?.version !== 1) throw new Error('Expected the frozen legacy code review.');
      const approval = review.maintenanceApproval;
      if (approval?.version !== 1) throw new Error('Expected a code review approval fixture.');
      const editedDraft = {
        ...payload.proposal.draft,
        rationale: 'First edit',
        unresolvedQuestions: ['Second edit'],
      };
      const approvedProposal = {
        ...payload.proposal,
        draft: editedDraft,
        body: 'Approved edited body',
        finalBodyHash: 'e'.repeat(64),
        changedOrdinals: [0],
      };
      const withApproval = {
        ...review,
        maintenanceApproval: {
          ...approval,
          preview: {...approval.preview, approvedProposal},
        },
      };
      const projected = projectManagerTopicReview(withApproval, {caseId, observationMatches: true})!;
      expect(projected.draft).toEqual(editedDraft);
      expect(projected.proposal).toMatchObject({
        body: 'Approved edited body',
        finalBodyHash: 'e'.repeat(64),
        changedOrdinals: [0],
      });
      expect(payload.proposal.draft.rationale).toBe('Current');
      expect(JSON.stringify(projected)).not.toContain('PRIVATE BASELINE');
    }),
  );
  effectIt.effect('omits arbitrary private before-content and source pins at every approval stage', () =>
    Effect.sync(() => {
      const approval = review.maintenanceApproval;
      if (approval?.version !== 1) throw new Error('Expected a code review approval fixture.');
      fc.assert(
        fc.property(
          fc.constantFrom('preview', 'prepared', 'written', 'conflict' as const),
          fc.string({maxLength: 40}),
          (stage, suffix) => {
            const privateBaseline = `PRIVATE_BASELINE_${suffix}`;
            const value = projectManagerTopicReview({
              ...review,
              maintenanceApproval: {
                ...approval,
                stage,
                preview: {...approval.preview, beforeContent: privateBaseline},
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
