import {it as effectIt} from '@effect/vitest';
import * as BunPath from '@effect/platform-bun/BunPath';
import {Effect, Path} from 'effect';
import {beforeEach, describe, expect, vi} from 'vitest';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {EffectMcpServerAdapter} from '@threadnote/threadnote/effect/ai/mcp';
import {registerContextMaintenanceTools} from '../../src/mcp/server/context/maintenance.js';
import {provideTestLayer} from '../helpers/effect-layer.js';

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  enrollmentPreview: vi.fn(),
  enrollmentApply: vi.fn(),
  draft: vi.fn(),
  view: vi.fn(),
  reviewPreview: vi.fn(),
  reviewApply: vi.fn(),
  decide: vi.fn(),
  project: vi.fn(),
  caseIdentity: vi.fn(),
  loadReview: vi.fn(),
}));
vi.mock('@threadnote/memory/candidate', async importOriginal => ({
  ...(await importOriginal<typeof import('@threadnote/memory/candidate')>()),
  loadCandidateReview: mocks.loadReview,
}));
vi.mock('../../src/memory/maintenance/topic_enrollment.js', () => ({
  inspectTopicEnrollment: mocks.inspect,
  previewTopicEnrollment: mocks.enrollmentPreview,
  applyTopicEnrollment: mocks.enrollmentApply,
}));
vi.mock('../../src/memory/context/maintenance_draft.js', () => ({
  requestTopicMaintenanceDraft: mocks.draft,
  readTopicMaintenanceDraft: mocks.view,
}));
vi.mock('../../src/memory/context/maintenance_review.js', () => ({
  prepareTopicMaintenanceReview: mocks.reviewPreview,
  applyTopicMaintenanceReview: mocks.reviewApply,
  decideTopicMaintenanceReview: mocks.decide,
}));
vi.mock('../../src/manager/topic_review.js', () => ({
  projectManagerTopicReview: mocks.project,
  managerTopicReviewCaseIdentity: mocks.caseIdentity,
}));

const config = {
  account: 'local',
  agentContextHome: '/private',
  agentId: 'threadnote',
  manifestPath: '/manifest',
  user: 'tester',
} as RuntimeConfig;
const reviewId = `review-${'a'.repeat(24)}`;
const caseId = `health-case-${'b'.repeat(40)}`;
const hash = 'c'.repeat(64);
const uri = 'threadnote://user/tester/memories/durable/topic.md';
const review = {reviewId, revision: 4, project: 'alpha', maintenance: {version: 1, basis: {targetUri: uri}}};
type ToolResult = {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly content?: readonly {readonly type: string; readonly text?: string}[];
};

function registeredTools() {
  const handlers = new Map<string, (input: Record<string, unknown>) => Effect.Effect<ToolResult, unknown, Path.Path>>();
  const server = {
    registerTool: (name: string, _definition: unknown, handler: unknown) => {
      handlers.set(name, handler as (input: Record<string, unknown>) => Effect.Effect<ToolResult, unknown, Path.Path>);
    },
  } as unknown as EffectMcpServerAdapter;
  registerContextMaintenanceTools(server, config);
  return (name: string, input: Record<string, unknown>) =>
    handlers.get(name)!(input).pipe(provideTestLayer(BunPath.layer));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspect.mockReturnValue(Effect.succeed({status: 'not-enrolled', targetUri: uri}));
  mocks.enrollmentPreview.mockReturnValue(Effect.succeed({status: 'preview', proposal: {revision: hash}}));
  mocks.enrollmentApply.mockReturnValue(Effect.succeed({status: 'enrolled', targetUri: uri}));
  mocks.draft.mockReturnValue(Effect.succeed(review));
  mocks.view.mockReturnValue(Effect.succeed(review));
  mocks.loadReview.mockReturnValue(Effect.succeed(review));
  mocks.reviewPreview.mockReturnValue(Effect.succeed(review));
  mocks.reviewApply.mockReturnValue(Effect.succeed(review));
  mocks.decide.mockReturnValue(Effect.succeed(review));
  mocks.project.mockReturnValue({
    kind: 'topic-maintenance',
    reviewId,
    revision: 4,
    approval: {approvalDigest: hash},
    canApply: true,
  });
  mocks.caseIdentity.mockReturnValue(Effect.succeed({caseId, observationMatches: true}));
});

describe('registered topic MCP adapters', () => {
  effectIt.effect('rejects missing or invalid actions before any enrollment or review service call', () =>
    Effect.gen(function* () {
      const call = registeredTools();
      for (const action of [undefined, 'invalid']) {
        const enrollment = yield* call('context_topic_enrollment', {
          uri,
          action,
          callerCwd: '/selected',
          inputJson: '{}',
          approved: true,
          expectedContentHash: hash,
          revision: hash,
        });
        const topicReview = yield* call('context_maintenance_review', {reviewId, action, revision: 4, caseId});
        expect(enrollment.isError).toBe(true);
        expect(topicReview.isError).toBe(true);
      }
      expect(mocks.inspect).not.toHaveBeenCalled();
      expect(mocks.enrollmentPreview).not.toHaveBeenCalled();
      expect(mocks.enrollmentApply).not.toHaveBeenCalled();
      expect(mocks.view).not.toHaveBeenCalled();
      expect(mocks.reviewPreview).not.toHaveBeenCalled();
      expect(mocks.reviewApply).not.toHaveBeenCalled();
      expect(mocks.decide).not.toHaveBeenCalled();
      expect(mocks.loadReview).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect('rejects malformed draft and approval inputs before service calls', () =>
    Effect.gen(function* () {
      const call = registeredTools();
      for (const input of [
        {caseId, modelId: 'gemma'},
        {caseId, backend: 'codex', modelId: 'gemma'},
        {caseId: 'bad', backend: 'local-ai', modelId: 'gemma'},
      ]) {
        expect((yield* call('context_maintenance_draft', input)).isError).toBe(true);
      }
      expect(
        (yield* call('context_maintenance_review', {
          action: 'apply',
          reviewId,
          revision: 4,
          approved: true,
          approvalDigest: 'bad',
          sourceCwd: '/selected',
        })).isError,
      ).toBe(true);
      expect(
        (yield* call('context_topic_enrollment', {
          action: 'enroll',
          uri,
          callerCwd: '/selected',
          inputJson: '{}',
          approved: false,
          expectedContentHash: hash,
          revision: hash,
        })).isError,
      ).toBe(true);
      expect(mocks.draft).not.toHaveBeenCalled();
      expect(mocks.reviewApply).not.toHaveBeenCalled();
      expect(mocks.enrollmentApply).not.toHaveBeenCalled();
      expect(mocks.loadReview).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect('passes exact view, preview, apply and decision inputs to the shared review services', () =>
    Effect.gen(function* () {
      const call = registeredTools();
      const view = yield* call('context_maintenance_review', {action: 'view', reviewId});
      expect(view.structuredContent).toMatchObject({kind: 'topic-maintenance', reviewId});
      yield* call('context_maintenance_review', {
        action: 'preview',
        reviewId,
        revision: 4,
        sourceCwd: '/selected',
        editedDraftJson: '{}',
      });
      yield* call('context_maintenance_review', {
        action: 'apply',
        reviewId,
        revision: 4,
        sourceCwd: '/selected',
        approvalDigest: hash,
        approved: true,
      });
      yield* call('context_maintenance_review', {action: 'defer', reviewId, revision: 4, caseId});
      expect(mocks.view).toHaveBeenCalledWith(config, reviewId, undefined);
      expect(mocks.loadReview).toHaveBeenCalledTimes(2);
      expect(mocks.loadReview).toHaveBeenCalledWith(config.agentContextHome, reviewId);
      expect(mocks.reviewPreview).toHaveBeenCalledWith(config, {
        reviewId,
        revision: 4,
        sourceCwd: '/selected',
        editedDraftJson: '{}',
      });
      expect(mocks.reviewApply).toHaveBeenCalledWith(config, {
        reviewId,
        revision: 4,
        sourceCwd: '/selected',
        approvalDigest: hash,
        approved: true,
      });
      expect(mocks.decide).toHaveBeenCalledWith(config, {reviewId, revision: 4, action: 'defer', caseId});
      expect(mocks.project).toHaveBeenCalledTimes(4);
      expect(mocks.project).toHaveBeenCalledWith(review, {caseId, observationMatches: true});
    }),
  );

  effectIt.effect('routes explicit enrollment and generation without touching accepted content here', () =>
    Effect.gen(function* () {
      const call = registeredTools();
      yield* call('context_topic_enrollment', {action: 'inspect', uri});
      yield* call('context_topic_enrollment', {
        action: 'preview',
        uri,
        callerCwd: '/selected',
        inputJson: '{"paragraphs":[]}',
      });
      yield* call('context_topic_enrollment', {
        action: 'enroll',
        uri,
        callerCwd: '/selected',
        inputJson: '{"paragraphs":[]}',
        approved: true,
        expectedContentHash: hash,
        revision: hash,
      });
      yield* call('context_maintenance_draft', {caseId, backend: 'local-ai', modelId: 'gemma', regenerate: true});
      expect(mocks.inspect).toHaveBeenCalledWith(config, uri);
      expect(mocks.enrollmentPreview).toHaveBeenCalledWith(config, {
        uri,
        callerCwd: '/selected',
        input: {paragraphs: []},
      });
      expect(mocks.enrollmentApply).toHaveBeenCalledWith(config, {
        uri,
        callerCwd: '/selected',
        input: {paragraphs: []},
        expectedContentHash: hash,
        revision: hash,
        approved: true,
      });
      expect(mocks.draft).toHaveBeenCalledWith(config, {
        caseId,
        backend: 'local-ai',
        modelId: 'gemma',
        regenerate: true,
      });
      expect(mocks.caseIdentity).toHaveBeenCalledWith(config, review);
      expect(mocks.project).toHaveBeenCalledWith(review, {caseId, observationMatches: true});
    }),
  );

  effectIt.effect('passes stale case identity without treating its presence as current observation', () =>
    Effect.gen(function* () {
      mocks.caseIdentity.mockReturnValue(Effect.succeed({caseId, observationMatches: false}));
      const call = registeredTools();
      yield* call('context_maintenance_review', {action: 'view', reviewId});
      yield* call('context_maintenance_draft', {caseId, backend: 'local-ai', modelId: 'gemma'});
      expect(mocks.project).toHaveBeenNthCalledWith(1, review, {caseId, observationMatches: false});
      expect(mocks.project).toHaveBeenNthCalledWith(2, review, {caseId, observationMatches: false});
    }),
  );
});
