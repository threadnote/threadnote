import type {CandidateReview} from '@threadnote/memory/candidate';
import type {PreparedMemoryV1} from './maintenance_preparation_state.js';

/** A generated journal is replaceable only while no human or writer has taken ownership. */
export function untouchedAutomaticReview(review: CandidateReview): boolean {
  const payload = review.maintenance;
  return (
    payload?.version === 3 &&
    payload.proposal.draft.purpose === 'automatic' &&
    payload.generation.origin !== 'manual' &&
    payload.generation.attempts > 0 &&
    review.candidates.length === 1 &&
    review.candidates[0].state === 'pending' &&
    !review.maintenanceApproval &&
    !review.maintenanceClosedConflict &&
    review.auditEvents.every(event => event.action === 'create_review')
  );
}

export function automaticReviewIsAssessment(review: CandidateReview): boolean {
  return (
    untouchedAutomaticReview(review) &&
    review.maintenance?.version === 3 &&
    ['insufficient-evidence', 'policy-conflict'].includes(review.maintenance.proposal.draft.outcome)
  );
}

/** Missing/partial readiness must never manufacture a material-change retirement or model retry. */
export function automaticReviewCanConverge(
  review: CandidateReview,
  prepared: Pick<PreparedMemoryV1, 'assessment' | 'relevantRevision' | 'reads' | 'omissions'>,
): boolean {
  if (!untouchedAutomaticReview(review) || review.maintenance?.version !== 3) return false;
  const basis = review.maintenance.basis;
  if (
    basis.targetUri !== prepared.assessment.target.uri ||
    basis.observationRevision === prepared.relevantRevision ||
    prepared.omissions.some(reason =>
      /unavailable|unreadable|unknown|ambiguous|time-boundary|not-ready|changed|policy/.test(reason),
    )
  )
    return false;
  // A transient empty code vector is not proof that the previously admitted context became obsolete.
  return (
    !basis.reads.some(read => read.uri.startsWith('code:')) || prepared.reads.some(read => read.uri.startsWith('code:'))
  );
}
