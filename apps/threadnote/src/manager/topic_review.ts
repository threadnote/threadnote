import {isSafeInteger as checkedIsSafeInteger} from '@threadnote/platform/validation';
import {Array as EffectArray, Option as EffectOption} from 'effect';
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
  TopicReviewError,
  type TopicReviewDecisionInput,
} from '../memory/context/maintenance_review.js';
import {topicMaintenanceCaseId} from '../memory/context/maintenance_topic.js';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {
  isCodeTopicMaintenanceManifest,
  topicMaintenanceAcceptedCitation,
  validateTopicMaintenanceManifest,
} from '@threadnote/memory/topic-maintenance';
import {maintenanceContentHash} from '../memory/context/maintenance_policy.js';
import {
  projectTopicReviewRecovery,
  projectTopicReviewDecisionAcknowledgement,
} from '../memory/context/maintenance_review_projection.js';
import {readMemoryRecordsByUri} from '../mcp/server/memory.js';
import {managerAttentionProjectRoot} from './attention.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const REVIEW = /^review-[a-f0-9]{24}$/u;
const CASE = /^health-case-[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
class InvalidTopicDraftJson extends Schema.TaggedError<InvalidTopicDraftJson, {readonly brand: unique symbol}>()(
  'InvalidTopicDraftJson',
  {},
) {}
const invalid = (error: string) => ({status: 400, body: {code: 'invalid-topic-review-request', error}});
const conflict = (error: string, code = 'topic-review-changed') => ({status: 409, body: {code, error}});
const missing = () => ({
  status: 404,
  body: {code: 'topic-review-missing', error: 'This topic review is unavailable. Refresh the review inbox.'},
});
const keys = (body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  EffectArray.every(required, key => EffectRecord.has(body, key)) &&
  EffectArray.every(EffectRecord.keys(body), key => required.includes(key) || optional.includes(key));
const exactRevision = (value: unknown): value is number =>
  typeof value === 'number' && checkedIsSafeInteger(value) && value > 0;

export interface ManagerTopicReviewCaseIdentity {
  readonly caseId: string;
  readonly observationMatches: boolean;
  readonly approvedContentMatches?: boolean;
  /** Supplied only after the checked async reader reauthorizes this exact private review. */
  readonly importedAccess?: {readonly reviewId: string; readonly revision: number};
}

/** Receipt-only projection: a retained old citation alone does not establish refreshed current support. */
function resolvedTopicCitationIds(review: CandidateReview): readonly string[] | undefined {
  const maintenance = review.maintenance;
  const approval = review.maintenanceApproval;
  if (maintenance?.version !== 1 || approval?.stage !== 'written' || review.candidates[0]?.state !== 'applied')
    return undefined;
  try {
    const uri = maintenance.basis.targetUri;
    const before = parseMemoryDocument(uri, approval.preview.beforeContent);
    const after = parseMemoryDocument(uri, approval.preview.content);
    if (
      !before ||
      !after ||
      maintenanceContentHash(before.content) !== maintenance.basis.targetHash ||
      maintenanceContentHash(before.content) !== approval.preview.beforeContentHash ||
      maintenanceContentHash(after.content) !== approval.preview.contentHash ||
      approval.preview.targetUri !== uri
    )
      return undefined;
    const old = validateTopicMaintenanceManifest(before.metadata.topicMaintenance, before);
    const next = validateTopicMaintenanceManifest(after.metadata.topicMaintenance, after);
    if (!isCodeTopicMaintenanceManifest(old) || !isCodeTopicMaintenanceManifest(next)) return undefined;
    const declared = (manifest: typeof old) => [
      ...new Set([
        ...EffectArray.flatMap(manifest.paragraphs, item => item.citationIds),
        ...EffectArray.map(manifest.additionalDependencies, item => item.citationId),
      ]),
    ];
    const activeAfter = new Set(EffectArray.map(declared(next), id => topicMaintenanceAcceptedCitation(after, id).id));
    const resolved = EffectArray.flatMap(declared(old), id => {
      const current = EffectOption.getOrUndefined(
        EffectArray.findFirst(maintenance.reviewEvidence, item => item.handleId === `current:${id}`),
      );
      return current &&
        !('sourceKind' in current) &&
        current.provenance === 'current-verified' &&
        current.supportsCitation &&
        !current.truncated &&
        EffectArray.some(
          maintenance.basis.handles,
          handle => handle.id === current.handleId && handle.variant === 'current' && handle.citationId === id,
        ) &&
        activeAfter.has(current.citation.id)
        ? [topicMaintenanceAcceptedCitation(before, id).id]
        : [];
    });
    return [...new Set(resolved)].sort();
  } catch {
    return undefined;
  }
}

/** No private receipt, source pin, or pre-approval content escapes this projection. */
export function projectManagerTopicReview(
  review: CandidateReview,
  identity?: ManagerTopicReviewCaseIdentity,
): ManagerTopicReviewV1 | undefined {
  const maintenance = review.maintenance;
  const candidate = review.candidates[0];
  if (!maintenance || maintenance.version === 3 || !candidate || review.candidates.length !== 1) return undefined;
  if (
    maintenance.version === 2 &&
    (identity?.importedAccess?.reviewId !== review.reviewId || identity.importedAccess.revision !== review.revision)
  )
    return undefined;
  const approval = review.maintenanceApproval;
  if (approval?.version === 3) return undefined;
  const currentCase = maintenance.generation.origin === 'manual' || identity?.observationMatches === true;
  const effectiveProposal = approval?.preview.approvedProposal ?? maintenance.proposal;
  const paragraphCoverage = topicMaintenanceParagraphCoverage(maintenance.basis, effectiveProposal.draft);
  const canFinishVerification =
    identity?.approvedContentMatches === true &&
    ((candidate.state === 'applying' && approval?.stage === 'prepared') ||
      (candidate.state === 'applied' && approval?.stage === 'written' && identity.observationMatches));
  const coverageAllowsApply = maintenance.generation.origin === 'manual' || paragraphCoverage.status === 'complete';
  const resolvedCitationIds = resolvedTopicCitationIds(review);
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
    ...(resolvedCitationIds === undefined ? {} : {resolvedCitationIds}),
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
    support: EffectArray.flatMap(maintenance.basis.handles, handle => {
      const evidence =
        maintenance.version === 2
          ? EffectOption.getOrUndefined(
              EffectArray.findFirst(maintenance.reviewEvidence, item => item.handleId === handle.id),
            )
          : EffectOption.getOrUndefined(
              EffectArray.findFirst(maintenance.reviewEvidence, item => item.handleId === handle.id),
            );
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
    warnings: EffectArray.map((candidate.evidence ?? []).slice(0, 16), item =>
      Effect2.pipe(item, EffectString.slice(0, 512)),
    ),
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
  if (review.maintenance?.version === 3) return undefined;
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
  const item = status?.cases[0];
  const approvedContentMatches =
    ((review.candidates[0]?.state === 'applying' && review.maintenanceApproval?.stage === 'prepared') ||
      (review.candidates[0]?.state === 'applied' &&
        review.maintenanceApproval?.stage === 'written' &&
        item?.evidenceRevision === review.maintenance.basis.observationRevision &&
        EffectOption.getOrUndefined(
          EffectOption.map(EffectOption.fromNullishOr(item.subjectContentHashes), __effectArrayReceiver =>
            EffectOption.getOrUndefined(
              EffectArray.findFirst(__effectArrayReceiver, subject => subject.uri === target.uri),
            ),
          ),
        )?.hash === review.maintenance.basis.targetHash)) &&
    target.content === review.maintenanceApproval?.preview.content;
  return item?.caseId === caseId &&
    item.memoryId === target.metadata.memoryId &&
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
    const reviewId = request.url.searchParams.get('reviewId');
    const caseId = request.url.searchParams.get('caseId');
    const keys = [...request.url.searchParams.keys()];
    if (
      !isManagerProjectName(project) ||
      keys.length !== 2 ||
      (reviewId === null) === (caseId === null) ||
      (reviewId === null ? !CASE.test(caseId ?? '') : !REVIEW.test(reviewId)) ||
      EffectArray.some(keys, key => key !== 'project' && key !== 'reviewId' && key !== 'caseId')
    )
      return invalid('Select an exact project and topic review.');
    if (caseId !== null) {
      const status = yield* readContextMaintenanceStatus(request.config, project, {caseId}).pipe(Effect.result);
      if (Result.isFailure(status)) return missing();
      const item = status.success.cases[0];
      if (
        item?.caseId !== caseId ||
        item.project !== project ||
        item.family !== 'topic-maintenance' ||
        item.slot !== 'declared-support' ||
        !Effect2.pipe(item.subjectUri, effectOptionalString =>
          effectOptionalString == null
            ? undefined
            : Effect2.pipe(
                effectOptionalString,
                EffectString.startsWith(`threadnote://user/${request.config.user}/memories/durable/`),
              ),
        )
      )
        return missing();
      const expectedReviewId = `review-${Effect2.pipe(sha256HexSync(`topic-maintenance\0${item.subjectUri}`), EffectString.slice(0, 24))}`;
      const loaded = yield* loadCandidateReview(request.config.agentContextHome, expectedReviewId).pipe(Effect.result);
      if (Result.isFailure(loaded)) return missing();
      const selected = loaded.success;
      const approval = selected.maintenanceApproval;
      const payload = selected.maintenance;
      if (
        selected.reviewId !== expectedReviewId ||
        selected.project !== project ||
        selected.candidates.length !== 1 ||
        !payload ||
        !approval ||
        payload.basis.targetUri !== item.subjectUri ||
        payload.basis.observationRevision !== item.evidenceRevision ||
        payload.basis.targetHash !==
          EffectOption.getOrUndefined(
            EffectOption.map(EffectOption.fromNullishOr(item.subjectContentHashes), __effectArrayReceiver =>
              EffectOption.getOrUndefined(
                EffectArray.findFirst(__effectArrayReceiver, subject => subject.uri === item.subjectUri),
              ),
            ),
          )?.hash ||
        approval.preview.reviewId !== expectedReviewId ||
        approval.preview.targetUri !== item.subjectUri ||
        approval.preview.beforeContentHash !== payload.basis.targetHash ||
        !(
          (selected.candidates[0].state === 'applying' && approval.stage === 'prepared') ||
          (selected.candidates[0].state === 'applied' && approval.stage === 'written')
        )
      )
        return missing();
      const target = (yield* readMemoryRecordsByUri(request.config, [item.subjectUri]).pipe(
        Effect.orElseSucceed(() => []),
      ))[0];
      if (
        !target ||
        target.uri !== item.subjectUri ||
        target.metadata.project !== project ||
        target.metadata.memoryId !== item.memoryId ||
        topicMaintenanceCaseId(target) !== caseId ||
        target.content !== approval.preview.content ||
        maintenanceContentHash(target.content) !== approval.preview.contentHash
      )
        return missing();
      if (payload.version === 2) {
        const checked = yield* readTopicMaintenanceDraft(request.config, expectedReviewId).pipe(Effect.result);
        if (Result.isFailure(checked) || JSON.stringify(checked.success) !== JSON.stringify(selected)) return missing();
      }
      const response = yield* topicReviewResponse(request.config, selected);
      return 'kind' in response.body &&
        response.body.kind === 'topic-maintenance' &&
        response.body.canFinishVerification
        ? response
        : missing();
    }
    const review = EffectOption.getOrUndefined(
      EffectArray.findFirst(
        yield* listCandidateReviews(request.config.agentContextHome),
        item => item.reviewId === reviewId,
      ),
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
      typeof body.expectedContentHash !== 'string' ||
      !HASH.test(body.expectedContentHash) ||
      typeof body.observationRevision !== 'string' ||
      !HASH.test(body.observationRevision) ||
      typeof body.inspectionDigest !== 'string' ||
      !HASH.test(body.inspectionDigest) ||
      !checkedIsSafeInteger(body.fragmentStart) ||
      !checkedIsSafeInteger(body.fragmentEnd) ||
      body.fragmentStart < 0 ||
      body.fragmentEnd <= body.fragmentStart ||
      body.approved !== true ||
      (body.retentionDays !== undefined &&
        (!checkedIsSafeInteger(body.retentionDays) || body.retentionDays < 1 || body.retentionDays > 365))
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
      expectedContentHash: body.expectedContentHash,
      observationRevision: body.observationRevision,
      inspectionDigest: body.inspectionDigest,
      fragmentStart: body.fragmentStart,
      fragmentEnd: body.fragmentEnd,
      ...(body.retentionDays === undefined ? {} : {retentionDays: body.retentionDays}),
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
      !Effect2.pipe(body.modelId, EffectString.trim) ||
      bytes(body.modelId) > 256 ||
      EffectArray.some(
        [...body.modelId],
        character =>
          Effect2.pipe(
            character,
            EffectString.charCodeAt(0),
            Effect2.Option.getOrElse(() => NaN),
          ) < 32 ||
          Effect2.pipe(
            character,
            EffectString.charCodeAt(0),
            Effect2.Option.getOrElse(() => NaN),
          ) === 127,
      )
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
    const editedDraftJson = body.editedDraftJson;
    if (isPreview && typeof editedDraftJson === 'string') {
      const parsed = yield* Effect.try({
        try: (): unknown => JSON.parse(editedDraftJson),
        catch: () => InvalidTopicDraftJson.make({}),
      }).pipe(Effect.result);
      if (Result.isFailure(parsed)) return invalid('Edited draft must be valid JSON.');
    }
    if (isDecision && body.caseId !== undefined && (typeof body.caseId !== 'string' || !CASE.test(body.caseId)))
      return invalid('Select an exact topic maintenance case.');
  }
  if (isGenerate) {
    if (typeof body.caseId !== 'string' || typeof body.backend !== 'string' || typeof body.modelId !== 'string') {
      return invalid('Select an exact case, supported backend, and available model.');
    }
    const caseId = body.caseId;
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
      backend: body.backend === 'local-ai' || body.backend === 'effect-ai' ? body.backend : 'local-ai',
      modelId: body.modelId,
      regenerate: action === 'regenerate',
    }).pipe(Effect.result);
    if (Result.isFailure(outcome)) {
      const error = outcome.failure;
      if (Schema.is(TopicDraftError)(error) && error.reason && error.recovery && REVIEW.test(error.recovery.reviewId)) {
        const expectedReviewId = `review-${Effect2.pipe(sha256HexSync(`topic-maintenance\0${item.subjectUri}`), EffectString.slice(0, 24))}`;
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
  if (typeof body.reviewId !== 'string' || !exactRevision(body.revision))
    return invalid('Select an exact topic review and revision.');
  const reviewId = body.reviewId;
  const revision = body.revision;
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
        ? EffectOption.getOrUndefined(
            EffectArray.findFirst(selected.success.cases, item => item.caseId === body.caseId),
          )
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
      revision,
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
        revision,
        ...(root?.state === 'available' ? {sourceCwd: root.cwd} : {}),
        ...(body.editedDraftJson === undefined
          ? {}
          : typeof body.editedDraftJson === 'string'
            ? {editedDraftJson: body.editedDraftJson}
            : {}),
      }).pipe(Effect.result)
    : yield* applyTopicMaintenanceReview(request.config, {
        reviewId,
        revision,
        ...(root?.state === 'available' ? {sourceCwd: root.cwd} : {}),
        approvalDigest: typeof body.approvalDigest === 'string' ? body.approvalDigest : '',
        approved: true,
      }).pipe(Effect.result);
  if (Result.isFailure(result)) {
    if (
      isApply &&
      Schema.is(TopicReviewError)(result.failure) &&
      result.failure.message ===
        'The approved topic was saved; maintenance verification is pending. Retry finish verification.'
    )
      return conflict(
        'The approved topic was saved. Finish verification to complete this review.',
        'topic-review-verification-pending',
      );
    return conflict('The topic review, target, approval, or source changed. Reload the review and preview again.');
  }
  return yield* topicReviewResponse(request.config, result.success);
});

/** Link an existing private proposal to its exact maintenance packet without changing either store. */
export const managerTopicPacketReviewId = Effect.fn('managerTopicReview.packetLink')(function* (
  config: RuntimeConfig,
  packet: {readonly project: string; readonly memoryUri?: string; readonly evidenceRevision: string},
) {
  if (!packet.memoryUri) return undefined;
  const reviewId = `review-${Effect2.pipe(sha256HexSync(`topic-maintenance\0${packet.memoryUri}`), EffectString.slice(0, 24))}`;
  const review = EffectOption.getOrUndefined(
    EffectArray.findFirst(yield* listCandidateReviews(config.agentContextHome), item => item.reviewId === reviewId),
  );
  return review?.project === packet.project &&
    review.maintenance?.basis.targetUri === packet.memoryUri &&
    review.maintenance.basis.observationRevision === packet.evidenceRevision
    ? reviewId
    : undefined;
});
