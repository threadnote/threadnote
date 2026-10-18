import type {CandidateReview} from '@threadnote/memory/candidate';

/** Metadata only. Callers bind the project/case and authorize decisions before using this projection. */
export function projectTopicReviewRecovery(review: CandidateReview, caseId?: string) {
  if (review.maintenance?.version !== 2 || review.candidates.length !== 1) return undefined;
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
  return action === 'reject' && review.candidates[0]?.state === 'rejected'
    ? projectTopicReviewRecovery(review, caseId)
    : undefined;
}
