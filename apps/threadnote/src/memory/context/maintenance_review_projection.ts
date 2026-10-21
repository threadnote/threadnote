import type {CandidateReview} from '@threadnote/memory/candidate';

/** Metadata only. Callers bind the project/case and authorize decisions before using this projection. */
export function projectTopicReviewRecovery(review: CandidateReview, caseId?: string) {
  if ((review.maintenance?.version !== 2 && review.maintenance?.version !== 3) || review.candidates.length !== 1)
    return undefined;
  const state = review.candidates[0].state;
  const approval = review.maintenanceApproval;
  const canReject =
    (state === 'pending' && (!approval || approval.stage === 'preview' || approval.stage === 'parked')) ||
    (state === 'conflict' && approval?.stage === 'conflict');
  return {
    version: 1 as const,
    kind: 'topic-maintenance-recovery' as const,
    project: review.project,
    reviewId: review.reviewId,
    revision: review.revision,
    state,
    ...(caseId ? {caseId} : {}),
    ...(canReject && caseId ? {recovery: {action: 'reject' as const}} : {}),
  };
}

/** A successful rejection needs no subsequent permission to render private review text. */
export function projectTopicReviewDecisionAcknowledgement(review: CandidateReview, action: string, caseId?: string) {
  return (action === 'reject' && review.candidates[0]?.state === 'rejected') ||
    (review.maintenance?.version === 3 && ['defer', 'resume'].includes(action))
    ? projectTopicReviewRecovery(review, caseId)
    : undefined;
}

/** Public explicit-review response; Manager presentation is integrated in the later Library phase. */
export function projectAutomaticMemoryReview(review: CandidateReview) {
  const payload = review.maintenance;
  if (payload?.version !== 3 || review.candidates.length !== 1) return undefined;
  const candidate = review.candidates[0];
  const approval = review.maintenanceApproval;
  if (approval && approval.version !== 3) return undefined;
  const shared = payload.basis.assessment.target.visibility === 'shared';
  return {
    version: 1 as const,
    kind: 'automatic-memory-review' as const,
    reviewId: review.reviewId,
    revision: review.revision,
    state: candidate.state,
    targetUri: payload.basis.targetUri,
    targetHash: payload.basis.targetHash,
    purpose: payload.proposal.draft.purpose,
    acceptedBody: payload.basis.body,
    proposal: approval?.preview.approvedProposal ?? payload.proposal,
    sourceEvidence: payload.reviewEvidence,
    coverage: payload.basis.assessment.coverage,
    ...(approval
      ? {
          approval: {
            stage: approval.stage,
            reviewRevision: approval.reviewRevision,
            approvalDigest: approval.preview.approvalDigest,
            content: approval.preview.content,
            contentHash: approval.preview.contentHash,
            metadataDiff: approval.preview.metadataDiff,
            reviewedSupport: approval.preview.reviewedSupport,
          },
        }
      : {}),
    canApply:
      !shared &&
      ((candidate.state === 'pending' && approval?.stage === 'preview') ||
        (candidate.state === 'applying' && approval?.stage === 'prepared')),
    ...(shared
      ? {
          ownerProposal: {
            operation: 'share_propose',
            reviewId: review.reviewId,
            revision: review.revision,
            uri: payload.basis.targetUri,
            authority: 'shared-owner',
            publicationApprovalRequired: true,
            instructions:
              'An authorized team owner must export this exact review through the existing shared Git proposal and separately approve publication. Read-only teams cannot apply it.',
          },
        }
      : {}),
  };
}
