import {isManagerProjectName} from './project/name.js';
import {Effect, Result, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {listCandidateReviews, loadCandidateReview, type CandidateReview} from '@threadnote/memory/candidate';
import {
  MAX_TOPIC_MAINTENANCE_DRAFT_BYTES,
  topicMaintenanceParagraphCoverage,
  topicGenerationDiagnosticSummary,
} from '@threadnote/memory/topic-maintenance-draft';
import type {ManagerTopicReviewV1} from '@threadnote/manager/attention/topic-contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readContextMaintenancePacket, readContextMaintenanceStatus} from '../memory/context/maintenance.js';
import {
  readTopicMaintenanceDraft,
  requestTopicMaintenanceDraft,
  TopicDraftError,
} from '../memory/context/maintenance_draft.js';
import {captureTopicObsidianEvidence} from '../memory/context/maintenance_obsidian.js';
import {
  applyTopicMaintenanceReview,
  decideTopicMaintenanceReview,
  prepareTopicMaintenanceReview,
  type TopicReviewDecisionInput,
} from '../memory/context/maintenance_review.js';
import {topicMaintenanceCaseId} from '../memory/context/maintenance_topic.js';
import {
  projectTopicReviewRecovery,
  projectTopicReviewDecisionAcknowledgement,
} from '../memory/context/maintenance_review_projection.js';
import {readMemoryRecordsByUri} from '../mcp/server/memory.js';
import {managerAttentionProjectRoot} from './attention.js';

const REVIEW = /^review-[a-f0-9]{24}$/u;
const CASE = /^health-case-[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
class InvalidTopicDraftJson extends Schema.TaggedError<InvalidTopicDraftJson>()('InvalidTopicDraftJson', {}) {}
const invalid = (error: string) => ({status: 400, body: {code: 'invalid-topic-review-request', error}});
const conflict = (error: string, code = 'topic-review-changed') => ({status: 409, body: {code, error}});
const missing = () => ({
  status: 404,
  body: {code: 'topic-review-missing', error: 'This topic review is unavailable. Refresh the review inbox.'},
});
const keys = (body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(body, key)) &&
  Object.keys(body).every(key => required.includes(key) || optional.includes(key));
const exactRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export interface ManagerTopicReviewCaseIdentity {
  readonly caseId: string;
  readonly observationMatches: boolean;
  readonly approvedContentMatches?: boolean;
  /** Supplied only after the checked async reader reauthorizes this exact private review. */
  readonly importedAccess?: {readonly reviewId: string; readonly revision: number};
}

/** No private receipt, source pin, or pre-approval content escapes this projection. */
export function projectManagerTopicReview(
  review: CandidateReview,
  identity?: ManagerTopicReviewCaseIdentity,
): ManagerTopicReviewV1 | undefined {
  const maintenance = review.maintenance;
  const candidate = review.candidates[0];
  if (!maintenance || !candidate || review.candidates.length !== 1) return undefined;
  if (
    maintenance.version === 2 &&
    (identity?.importedAccess?.reviewId !== review.reviewId || identity.importedAccess.revision !== review.revision)
  )
    return undefined;
  const approval = review.maintenanceApproval;
  const currentCase = maintenance.generation.origin === 'manual' || identity?.observationMatches === true;
  const effectiveProposal = approval?.preview.approvedProposal ?? maintenance.proposal;
  const paragraphCoverage = topicMaintenanceParagraphCoverage(maintenance.basis, effectiveProposal.draft);
  const canFinishVerification =
    candidate.state === 'applying' && approval?.stage === 'prepared' && identity?.approvedContentMatches === true;
  const coverageAllowsApply = maintenance.generation.origin === 'manual' || paragraphCoverage.status === 'complete';
  const canApply =
    coverageAllowsApply &&
    ((candidate.state === 'pending' &&
      approval?.stage === 'preview' &&
      approval.reviewRevision === review.revision &&
      currentCase) ||
      (candidate.state === 'applying' && approval?.stage === 'prepared'));
  return {
    version: 1,
    kind: 'topic-maintenance',
    sourceKind: maintenance.version === 2 ? 'obsidian' : 'code',
    project: review.project,
    reviewId: review.reviewId,
    revision: review.revision,
    state: candidate.state,
    topic: review.topic,
    ...(identity ? {caseId: identity.caseId} : {}),
    caseObservationMatches: identity?.observationMatches === true,
    targetUri: maintenance.basis.targetUri,
    targetHash: maintenance.basis.targetHash,
    acceptedBody: maintenance.basis.body,
    observationRevision: maintenance.basis.observationRevision,
    coverage: 'declared-only',
    paragraphCoverage,
    generation: {
      origin: maintenance.generation.origin === 'manual' ? 'manual' : 'model',
      agent: maintenance.generation.agent,
      model: maintenance.generation.model,
      attempts: maintenance.generation.attempts,
      usage: maintenance.generation.usage,
      ...(maintenance.generation.origin !== 'manual' && maintenance.generation.observation
        ? {observation: topicGenerationDiagnosticSummary(maintenance.generation.observation)}
        : {}),
    },
    draft: effectiveProposal.draft,
    proposal: {
      body: effectiveProposal.body,
      finalBodyHash: effectiveProposal.finalBodyHash,
      changedOrdinals: effectiveProposal.changedOrdinals,
    },
    paragraphs: maintenance.basis.paragraphs,
    additionalDependencies: maintenance.basis.additionalDependencies,
    support: maintenance.basis.handles.flatMap(handle => {
      const evidence = maintenance.reviewEvidence.find(item => item.handleId === handle.id);
      return evidence
        ? [
            {
              handleId: handle.id,
              citationId: handle.citationId,
              variant: handle.variant,
              path: 'sourceKind' in evidence ? evidence.citation.relativePath : evidence.source.path,
              provenance: evidence.provenance,
            },
          ]
        : [];
    }),
    warnings: candidate.evidence.slice(0, 16).map(item => item.slice(0, 512)),
    ...(approval
      ? {
          approval: {
            stage: approval.stage,
            reviewRevision: approval.reviewRevision,
            approvalDigest: approval.preview.approvalDigest,
            content: approval.preview.content,
            contentHash: approval.preview.contentHash,
            metadataDiff: approval.preview.metadataDiff,
          },
        }
      : {}),
    canApply,
    canFinishVerification,
    ...(canApply
      ? {}
      : {
          blockingReason:
            candidate.state !== 'pending' && candidate.state !== 'applying'
              ? `Review is ${candidate.state}.`
              : !coverageAllowsApply
                ? 'Paragraph review is incomplete or legacy. Regenerate or explicitly review every eligible paragraph.'
                : !currentCase && approval?.stage !== 'prepared'
                  ? 'The matching topic case is unavailable. Refresh maintenance.'
                  : approval
                    ? `Approval is ${approval.stage}.`
                    : 'Preview the exact draft before accepting.',
        }),
  };
}

export const managerTopicReviewCaseIdentity = Effect.fn('managerTopicReview.caseIdentity')(function* (
  config: RuntimeConfig,
  review: CandidateReview,
) {
  if (!review.maintenance) return undefined;
  const imported = review.maintenance.version === 2;
  if (imported) {
    const checked = yield* readTopicMaintenanceDraft(config, review.reviewId).pipe(Effect.result);
    if (Result.isFailure(checked) || JSON.stringify(checked.success) !== JSON.stringify(review)) return undefined;
  }
  const importedAccess = imported ? {reviewId: review.reviewId, revision: review.revision} : undefined;
  const target = (yield* readMemoryRecordsByUri(config, [review.maintenance.basis.targetUri]).pipe(
    Effect.orElseSucceed(() => []),
  ))[0];
  if (
    !target ||
    target.uri !== review.maintenance.basis.targetUri ||
    target.metadata.project !== review.project ||
    !target.metadata.memoryId
  )
    return undefined;
  const caseId = topicMaintenanceCaseId(target);
  const status = yield* readContextMaintenanceStatus(config, review.project, {caseId}).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  const approvedContentMatches =
    review.candidates[0]?.state === 'applying' &&
    review.maintenanceApproval?.stage === 'prepared' &&
    target.content === review.maintenanceApproval.preview.content;
  const item = status?.cases[0];
  return item?.caseId === caseId &&
    item.family === 'topic-maintenance' &&
    item.slot === 'declared-support' &&
    item.subjectUri === target.uri &&
    item.project === review.project
    ? {
        caseId,
        observationMatches: item.evidenceRevision === review.maintenance.basis.observationRevision,
        approvedContentMatches,
        ...(importedAccess ? {importedAccess} : {}),
      }
    : approvedContentMatches
      ? {caseId, observationMatches: false, approvedContentMatches: true, ...(importedAccess ? {importedAccess} : {})}
      : importedAccess
        ? {caseId, observationMatches: false, importedAccess}
        : undefined;
});

const topicReviewResponse = Effect.fn('managerTopicReview.response')(function* (
  config: RuntimeConfig,
  review: CandidateReview,
) {
  const identity = yield* managerTopicReviewCaseIdentity(config, review);
  const projected = projectManagerTopicReview(review, identity);
  if (projected) return {status: 200, body: projected};
  if (review.maintenance?.version !== 2) return missing();
  // Resolve the persisted case independently of permission to render its old private text.
  const target = (yield* readMemoryRecordsByUri(config, [review.maintenance.basis.targetUri]).pipe(
    Effect.orElseSucceed(() => []),
  ))[0];
  if (
    !target ||
    target.uri !== review.maintenance.basis.targetUri ||
    target.metadata.project !== review.project ||
    !target.metadata.memoryId
  )
    return missing();
  const caseId = topicMaintenanceCaseId(target);
  const status = yield* readContextMaintenanceStatus(config, review.project, {caseId}).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  const item = status?.cases[0];
  if (
    item?.caseId !== caseId ||
    item.project !== review.project ||
    item.family !== 'topic-maintenance' ||
    item.slot !== 'declared-support' ||
    item.subjectUri !== review.maintenance.basis.targetUri
  )
    return missing();
  return {status: 200, body: projectTopicReviewRecovery(review, caseId)!};
});

export const handleManagerTopicReview = Effect.fn('managerTopicReview.handle')(function* (request: {
  readonly config: RuntimeConfig;
  readonly method: string;
  readonly url: URL;
  readonly body: Effect.Effect<Record<string, unknown>, unknown>;
}) {
  if (request.url.pathname !== '/api/attention/topic-review') return undefined;
  if (request.method === 'GET') {
    const project = request.url.searchParams.get('project') ?? '';
    const reviewId = request.url.searchParams.get('reviewId') ?? '';
    if (
      !isManagerProjectName(project) ||
      !REVIEW.test(reviewId) ||
      [...request.url.searchParams.keys()].some(key => key !== 'project' && key !== 'reviewId')
    )
      return invalid('Select an exact project and topic review.');
    const review = (yield* listCandidateReviews(request.config.agentContextHome)).find(
      item => item.reviewId === reviewId,
    );
    if (!review || review.project !== project || !review.maintenance) return missing();
    return yield* topicReviewResponse(request.config, review);
  }
  if (request.method !== 'POST') return undefined;
  const body = yield* request.body;
  if (bytes(JSON.stringify(body)) > MAX_TOPIC_MAINTENANCE_DRAFT_BYTES + 4096)
    return invalid('Topic review request exceeds the 36 KiB boundary.');
  const project = body.project;
  if (typeof project !== 'string' || !isManagerProjectName(project)) return invalid('Select a valid project.');
  const action = body.action;
  if (action === 'capture') {
    if (
      !keys(
        body,
        [
          'action',
          'project',
          'caseId',
          'expectedContentHash',
          'observationRevision',
          'inspectionDigest',
          'fragmentStart',
          'fragmentEnd',
          'approved',
        ],
        ['retentionDays'],
      ) ||
      typeof body.caseId !== 'string' ||
      !CASE.test(body.caseId) ||
      ![body.expectedContentHash, body.observationRevision, body.inspectionDigest].every(
        value => typeof value === 'string' && HASH.test(value),
      ) ||
      !Number.isSafeInteger(body.fragmentStart) ||
      !Number.isSafeInteger(body.fragmentEnd) ||
      (body.fragmentStart as number) < 0 ||
      (body.fragmentEnd as number) <= (body.fragmentStart as number) ||
      body.approved !== true ||
      (body.retentionDays !== undefined &&
        (!Number.isSafeInteger(body.retentionDays) ||
          (body.retentionDays as number) < 1 ||
          (body.retentionDays as number) > 365))
    )
      return invalid('Select a current source excerpt and approve its retention.');
    const packet = yield* readContextMaintenancePacket(request.config, body.caseId).pipe(Effect.result);
    if (
      Result.isFailure(packet) ||
      packet.success.project !== project ||
      !('topicEvidence' in packet.success) ||
      packet.success.topicEvidence.version !== 2
    )
      return conflict('The selected source changed. Refresh its evidence.');
    const captured = yield* captureTopicObsidianEvidence(request.config, {
      caseId: body.caseId,
      expectedContentHash: body.expectedContentHash as string,
      observationRevision: body.observationRevision as string,
      inspectionDigest: body.inspectionDigest as string,
      fragmentStart: body.fragmentStart as number,
      fragmentEnd: body.fragmentEnd as number,
      ...(body.retentionDays === undefined ? {} : {retentionDays: body.retentionDays as number}),
      approved: true,
    }).pipe(Effect.result);
    if (Result.isFailure(captured))
      return conflict('The source excerpt could not be retained. Refresh evidence before trying again.');
    const refreshed = yield* readContextMaintenancePacket(request.config, body.caseId).pipe(Effect.result);
    if (Result.isFailure(refreshed) || refreshed.success.project !== project)
      return conflict('Refresh the source evidence to check the retained excerpt.');
    return {status: 200, body: refreshed.success};
  }
  const isGenerate = action === 'generate' || action === 'regenerate';
  const isPreview = action === 'preview';
  const isApply = action === 'apply';
  const isDecision = action === 'reject' || action === 'defer' || action === 'resume';
  if (!isGenerate && !isPreview && !isApply && !isDecision) return invalid('Choose a supported topic review action.');
  if (isGenerate) {
    if (
      !keys(body, ['action', 'project', 'caseId', 'backend', 'modelId']) ||
      typeof body.caseId !== 'string' ||
      !CASE.test(body.caseId) ||
      (body.backend !== 'local-ai' && body.backend !== 'effect-ai') ||
      typeof body.modelId !== 'string' ||
      !body.modelId.trim() ||
      bytes(body.modelId) > 256 ||
      [...body.modelId].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      return invalid('Select an exact case, supported backend, and available model.');
  } else {
    const required = isApply
      ? ['action', 'project', 'reviewId', 'revision', 'approvalDigest', 'approved']
      : ['action', 'project', 'reviewId', 'revision'];
    const optional = isPreview ? ['editedDraftJson'] : isDecision ? ['caseId'] : [];
    if (
      !keys(body, required, optional) ||
      typeof body.reviewId !== 'string' ||
      !REVIEW.test(body.reviewId) ||
      !exactRevision(body.revision)
    )
      return invalid('Select an exact topic review and revision.');
    if (
      isApply &&
      (body.approved !== true || typeof body.approvalDigest !== 'string' || !HASH.test(body.approvalDigest))
    )
      return invalid('Apply requires explicit approval of the exact preview digest.');
    if (
      isPreview &&
      body.editedDraftJson !== undefined &&
      (typeof body.editedDraftJson !== 'string' || bytes(body.editedDraftJson) > MAX_TOPIC_MAINTENANCE_DRAFT_BYTES)
    )
      return invalid('Edited draft JSON must be within 32 KiB.');
    if (isPreview && typeof body.editedDraftJson === 'string') {
      const parsed = yield* Effect.try({
        try: (): unknown => JSON.parse(body.editedDraftJson as string),
        catch: () => InvalidTopicDraftJson.make({}),
      }).pipe(Effect.result);
      if (Result.isFailure(parsed)) return invalid('Edited draft must be valid JSON.');
    }
    if (isDecision && body.caseId !== undefined && (typeof body.caseId !== 'string' || !CASE.test(body.caseId)))
      return invalid('Select an exact topic maintenance case.');
  }
  if (isGenerate) {
    const caseId = body.caseId as string;
    const status = yield* readContextMaintenanceStatus(request.config, project, {caseId}).pipe(Effect.result);
    if (Result.isFailure(status)) return conflict('The selected topic case changed. Refresh maintenance.');
    const item = status.success.cases[0];
    if (
      item?.caseId !== caseId ||
      item.project !== project ||
      item.family !== 'topic-maintenance' ||
      item.slot !== 'declared-support'
    )
      return conflict('The selected topic case changed. Refresh maintenance.');
    const packet = yield* readContextMaintenancePacket(request.config, caseId).pipe(Effect.result);
    if (
      Result.isFailure(packet) ||
      packet.success.project !== project ||
      packet.success.caseId !== caseId ||
      !('topicEvidence' in packet.success) ||
      packet.success.topicEvidence.outcome !== 'ready' ||
      packet.success.memoryUri !== item.subjectUri
    )
      return conflict('Topic evidence is unavailable or changed. Refresh maintenance.');
    if (packet.success.topicEvidence.version !== 2) {
      const root = yield* managerAttentionProjectRoot(request.config, project);
      if (root.state === 'unavailable')
        return conflict(
          'Repository evidence is unavailable for this project. Refresh its local checkout.',
          'topic-source-unavailable',
        );
    }
    const outcome = yield* requestTopicMaintenanceDraft(request.config, {
      caseId,
      backend: body.backend as 'local-ai' | 'effect-ai',
      modelId: body.modelId as string,
      regenerate: action === 'regenerate',
    }).pipe(Effect.result);
    if (Result.isFailure(outcome)) {
      const error = outcome.failure;
      if (Schema.is(TopicDraftError)(error) && error.reason && error.recovery && REVIEW.test(error.recovery.reviewId)) {
        const expectedReviewId = `review-${sha256HexSync(`topic-maintenance\0${item.subjectUri}`).slice(0, 24)}`;
        const loaded = yield* loadCandidateReview(request.config.agentContextHome, error.recovery.reviewId).pipe(
          Effect.result,
        );
        const expectedState = {
          'review-applying': 'applying',
          'review-conflict': 'conflict',
          'review-deferred': 'deferred',
          'review-rejected': 'rejected',
          'review-preview-pending': 'pending',
          'review-pending': 'pending',
        }[error.reason];
        if (
          Result.isSuccess(loaded) &&
          loaded.success.reviewId === expectedReviewId &&
          error.recovery.reviewId === expectedReviewId &&
          loaded.success.project === project &&
          loaded.success.maintenance?.basis.targetUri === item.subjectUri &&
          loaded.success.candidates.length === 1 &&
          loaded.success.candidates[0].state === expectedState &&
          error.recovery.state === expectedState
        )
          return {
            status: 409,
            body: {
              code: 'topic-draft-review-blocked',
              reason: error.reason,
              error:
                expectedState === 'conflict'
                  ? 'This topic has a recoverable review conflict. Open the exact review to resolve it.'
                  : 'An existing topic review blocks generation. Open the exact review before continuing.',
              recovery: {action: 'open-review', reviewId: expectedReviewId, state: error.recovery.state},
            },
          };
      }
      const diagnostics = Schema.is(TopicDraftError)(error)
        ? topicGenerationDiagnosticSummary(error.diagnostics)
        : undefined;
      return {
        status: 409,
        body: {
          code: 'topic-draft-unavailable',
          error:
            'The topic draft could not be generated from this exact case and model. Refresh the case or model selection.',
          ...(diagnostics ? {diagnostics} : {}),
        },
      };
    }
    return yield* topicReviewResponse(request.config, outcome.success);
  }
  const reviewId = body.reviewId as string;
  const loaded = yield* loadCandidateReview(request.config.agentContextHome, reviewId).pipe(Effect.result);
  if (
    Result.isFailure(loaded) ||
    loaded.success.reviewId !== reviewId ||
    loaded.success.project !== project ||
    !loaded.success.maintenance
  )
    return missing();
  const review = loaded.success;
  const maintenance = review.maintenance;
  if (!maintenance) return missing();
  const importedRejection = maintenance.version === 2 && action === 'reject';
  const identity = importedRejection ? undefined : yield* managerTopicReviewCaseIdentity(request.config, review);
  if (maintenance.version === 2 && !identity?.importedAccess && !importedRejection) return missing();
  if (isDecision) {
    if (maintenance.generation.origin !== 'manual' || importedRejection) {
      if (typeof body.caseId !== 'string') return conflict('Select the exact topic case for this decision.');
      const selected = yield* readContextMaintenanceStatus(request.config, project, {caseId: body.caseId}).pipe(
        Effect.result,
      );
      const item = Result.isSuccess(selected)
        ? selected.success.cases.find(item => item.caseId === body.caseId)
        : undefined;
      if (
        item?.project !== project ||
        item.family !== 'topic-maintenance' ||
        item.slot !== 'declared-support' ||
        item.subjectUri !== maintenance.basis.targetUri ||
        (action === 'resume' && item.evidenceRevision !== maintenance.basis.observationRevision)
      )
        return conflict('The selected topic case changed. Refresh maintenance.');
    }
    const selection: TopicReviewDecisionInput = {
      reviewId,
      revision: body.revision as number,
      action,
      ...(typeof body.caseId === 'string' ? {caseId: body.caseId} : {}),
    };
    const decided = yield* decideTopicMaintenanceReview(request.config, selection).pipe(Effect.result);
    if (Result.isFailure(decided)) {
      const latest = yield* loadCandidateReview(request.config.agentContextHome, reviewId).pipe(Effect.result);
      const persisted = Result.isSuccess(latest) ? latest.success : undefined;
      const expectedState = action === 'resume' ? 'pending' : action === 'reject' ? 'rejected' : 'deferred';
      const lastEvent = persisted?.auditEvents.at(-1);
      if (
        !persisted ||
        persisted.project !== project ||
        persisted.revision !== selection.revision + 1 ||
        persisted.candidates.length !== 1 ||
        persisted.candidates[0].state !== expectedState ||
        lastEvent?.action !== action ||
        lastEvent.revision !== persisted.revision
      )
        return conflict('The topic review or case changed. Reload the review and try again.');
      const replay = yield* decideTopicMaintenanceReview(request.config, selection).pipe(Effect.result);
      if (Result.isSuccess(replay)) {
        const acknowledgement = projectTopicReviewDecisionAcknowledgement(replay.success, action, selection.caseId);
        if (acknowledgement) return {status: 200, body: acknowledgement};
        return yield* topicReviewResponse(request.config, replay.success);
      }
      return {
        status: 409,
        body: {
          code: 'topic-review-decision-reload-required',
          error: 'The review decision was saved. Reload the review to check its current state.',
        },
      };
    }
    const acknowledgement = projectTopicReviewDecisionAcknowledgement(decided.success, action, selection.caseId);
    if (acknowledgement) return {status: 200, body: acknowledgement};
    return yield* topicReviewResponse(request.config, decided.success);
  }
  if (
    maintenance.generation.origin !== 'manual' &&
    !identity?.observationMatches &&
    (isPreview || (isApply && review.candidates[0]?.state === 'pending'))
  )
    return conflict('The selected topic case changed. Refresh maintenance before preview or acceptance.');
  const root = maintenance.version === 2 ? undefined : yield* managerAttentionProjectRoot(request.config, project);
  if (root?.state === 'unavailable')
    return conflict(
      'Repository evidence is unavailable for this project. Refresh its local checkout.',
      'topic-source-unavailable',
    );
  const result = isPreview
    ? yield* prepareTopicMaintenanceReview(request.config, {
        reviewId,
        revision: body.revision as number,
        ...(root?.state === 'available' ? {sourceCwd: root.cwd} : {}),
        ...(body.editedDraftJson === undefined ? {} : {editedDraftJson: body.editedDraftJson as string}),
      }).pipe(Effect.result)
    : yield* applyTopicMaintenanceReview(request.config, {
        reviewId,
        revision: body.revision as number,
        ...(root?.state === 'available' ? {sourceCwd: root.cwd} : {}),
        approvalDigest: body.approvalDigest as string,
        approved: true,
      }).pipe(Effect.result);
  if (Result.isFailure(result))
    return conflict('The topic review, target, approval, or source changed. Reload the review and preview again.');
  return yield* topicReviewResponse(request.config, result.success);
});

/** Link an existing private proposal to its exact maintenance packet without changing either store. */
export const managerTopicPacketReviewId = Effect.fn('managerTopicReview.packetLink')(function* (
  config: RuntimeConfig,
  packet: {readonly project: string; readonly memoryUri?: string; readonly evidenceRevision: string},
) {
  if (!packet.memoryUri) return undefined;
  const reviewId = `review-${sha256HexSync(`topic-maintenance\0${packet.memoryUri}`).slice(0, 24)}`;
  const review = (yield* listCandidateReviews(config.agentContextHome)).find(item => item.reviewId === reviewId);
  return review?.project === packet.project &&
    review.maintenance?.basis.targetUri === packet.memoryUri &&
    review.maintenance.basis.observationRevision === packet.evidenceRevision
    ? reviewId
    : undefined;
});
