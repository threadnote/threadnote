import type {CandidateReview, MemoryCandidate} from '@threadnote/memory/candidate';
import type {
  KnowledgeDeltaMutationPreviewV1,
  KnowledgeDeltaReplacementSafetyV1,
  KnowledgeDeltaV1,
} from '@threadnote/memory/knowledge_delta';

export interface ReviewPreviewFixture {
  readonly delta: KnowledgeDeltaV1;
  readonly review: CandidateReview;
}

export interface ReviewPreviewFixtureOptions {
  readonly candidate?: Partial<MemoryCandidate>;
  readonly mutationPreview?: Partial<KnowledgeDeltaMutationPreviewV1>;
  readonly replacementSafety?: 'destructive-loss-risk' | 'preserving' | 'review-required';
  readonly review?: Partial<Pick<CandidateReview, 'project' | 'revision' | 'reviewId' | 'task' | 'topic'>>;
}

function replacementSafety(
  classification: 'destructive-loss-risk' | 'preserving' | 'review-required',
  bodyText: string,
): KnowledgeDeltaReplacementSafetyV1 {
  if (classification === 'review-required') {
    return {
      acknowledged: false,
      classification,
      requiresExplicitApproval: true,
      sectionListTruncated: false,
      warning: 'The replacement requires a fresh review.',
    };
  }
  return {
    acknowledged: false,
    classification,
    destructiveLossRisk: classification === 'destructive-loss-risk',
    missingSections: [],
    proposedBodyCharacters: bodyText.length,
    proposedNonEmptyLines: 1,
    requiresExplicitApproval: classification === 'destructive-loss-risk',
    retainedCharacterRatio: 1,
    retainedLineRatio: 1,
    sectionListTruncated: false,
    targetBodyCharacters: bodyText.length,
    targetNonEmptyLines: 1,
  };
}

export function reviewPreviewFixture(options: ReviewPreviewFixtureOptions = {}): ReviewPreviewFixture {
  const reviewId = options.review?.reviewId ?? 'review-fixture';
  const project = options.review?.project ?? 'threadnote';
  const topic = options.review?.topic ?? 'fixture';
  const revision = options.review?.revision ?? 1;
  const candidate: MemoryCandidate = {
    candidateId: 'candidate-fixture',
    categories: ['decision'],
    comparison: 'new',
    confidence: 1,
    evidence: [],
    kind: 'durable',
    project,
    proposedText: 'A complete candidate review fixture.',
    reason: 'A typed candidate review fixture.',
    recommendation: 'create',
    state: 'pending',
    topic,
    ...options.candidate,
  };
  const mutationPreview: KnowledgeDeltaMutationPreviewV1 = {
    bodyText: candidate.applyBodyText ?? candidate.proposedText,
    operation: 'create',
    ...(options.replacementSafety && options.mutationPreview?.operation !== 'no_action'
      ? {
          replacementSafety: replacementSafety(
            options.replacementSafety,
            candidate.applyBodyText ?? candidate.proposedText,
          ),
        }
      : options.mutationPreview?.operation === 'no_action'
        ? {}
        : {
            replacementSafety: replacementSafety('preserving', candidate.applyBodyText ?? candidate.proposedText),
          }),
    truncated: false,
    ...options.mutationPreview,
  };
  const review: CandidateReview = {
    auditEvents: [],
    candidates: [candidate],
    codeCitations: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    project,
    reviewId,
    revision,
    task: 'Review a candidate memory.',
    topic,
    version: 5,
    ...options.review,
  };
  const delta: KnowledgeDeltaV1 = {
    items: [
      {
        candidateId: candidate.candidateId,
        comparison: candidate.comparison,
        comparisonReason: candidate.reason,
        confidence: candidate.confidence,
        mutationPreview,
        proposedDestination: {
          kind: candidate.kind,
          project: candidate.project,
          ...(candidate.targetUri ? {targetUri: candidate.targetUri} : {}),
          topic: candidate.topic,
        },
        recommendation: candidate.recommendation,
        sourceEvidence: candidate.evidence,
        state: candidate.state,
        truncated: mutationPreview.truncated,
        type: 'decision-or-invariant',
      },
    ],
    noAction: candidate.recommendation === 'no_action',
    reviewId,
    revision,
    type: 'knowledge-delta',
    version: 1,
  };
  return {review, delta};
}
