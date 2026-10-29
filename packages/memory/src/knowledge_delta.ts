import {Array as EffectArray} from 'effect';
import {
  assessReplacementSafety,
  replacementSafetyReviewRequiredWarning,
  type CandidateComparison,
  type CandidateRecommendation,
  type CandidateReview,
  type CandidateReviewState,
  type LegacyMemoryCandidate,
  type MemoryCandidate,
  type ReplacementSafetyAssessmentV1,
  type StructuredCloseoutV1,
} from './candidate.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const KNOWLEDGE_DELTA_V1_MAX_ITEMS = 3;

const KNOWLEDGE_DELTA_V1_MAX_TEXT_CHARACTERS = 66_000;
const KNOWLEDGE_DELTA_V1_MAX_SOURCE_EVIDENCE = 34;

export type KnowledgeDeltaItemType =
  'context-repair-or-retirement' | 'decision-or-invariant' | 'handoff-state' | 'preference';

export interface KnowledgeDeltaEditedPreviewV1 {
  readonly bodyText: string;
  readonly candidateId: string;
  readonly revision: number;
}

export interface KnowledgeDeltaMutationPreviewV1 {
  readonly bodyText: string;
  readonly expectedTargetContentHash?: string;
  readonly operation: 'create' | 'no_action' | 'replace' | 'requires_explicit_operation';
  readonly replacementSafety?: KnowledgeDeltaReplacementSafetyV1;
  readonly replaceUri?: string;
  readonly truncated: boolean;
}

export type KnowledgeDeltaReplacementSafetyV1 =
  | (ReplacementSafetyAssessmentV1 & {
      readonly acknowledged: boolean;
      readonly classification: 'destructive-loss-risk' | 'preserving';
      readonly requiresExplicitApproval: boolean;
      readonly sectionListTruncated: boolean;
      readonly warning?: string;
    })
  | {
      readonly acknowledged: false;
      readonly classification: 'review-required';
      readonly requiresExplicitApproval: true;
      readonly sectionListTruncated: false;
      readonly warning: string;
    };

export interface KnowledgeDeltaItemV1 {
  readonly candidateId: string;
  readonly comparison: CandidateComparison;
  readonly comparisonReason: string;
  readonly confidence: number;
  readonly mutationPreview: KnowledgeDeltaMutationPreviewV1;
  readonly proposedDestination: {
    readonly kind: MemoryCandidate['kind'] | undefined;
    readonly project: string;
    readonly targetUri?: string;
    readonly topic: string;
  };
  readonly recommendation: CandidateRecommendation;
  readonly sourceEvidence: readonly string[];
  readonly state: CandidateReviewState;
  readonly truncated: boolean;
  readonly type: KnowledgeDeltaItemType;
}

export interface KnowledgeDeltaV1 {
  readonly items: readonly KnowledgeDeltaItemV1[];
  readonly noAction: boolean;
  readonly reviewId: string;
  readonly revision: number;
  readonly structuredCloseout?: StructuredCloseoutV1;
  readonly type: 'knowledge-delta';
  readonly version: 1;
}

export function projectKnowledgeDeltaV1(
  review: CandidateReview,
  editedPreview?: KnowledgeDeltaEditedPreviewV1,
): KnowledgeDeltaV1 {
  if (review.maintenanceCapture || review.maintenance?.version === 2)
    throw new Error('Private imported topic reviews require their access-checked review path.');
  if (editedPreview !== undefined) {
    if (editedPreview.revision !== review.revision) {
      throw new Error(
        `Candidate review revision changed: expected ${editedPreview.revision}, current ${review.revision}.`,
      );
    }
    if (!EffectArray.some(review.candidates, candidate => candidate.candidateId === editedPreview.candidateId)) {
      throw new Error(`Candidate ${editedPreview.candidateId} is not part of ${review.reviewId}.`);
    }
  }
  const items = EffectArray.map(
    [...review.candidates]
      .sort((left, right) => Effect.pipe(left.candidateId, EffectString.localeCompare(right.candidateId)))
      .slice(0, KNOWLEDGE_DELTA_V1_MAX_ITEMS),
    candidate =>
      projectKnowledgeDeltaItemV1(
        review,
        candidate,
        editedPreview?.candidateId === candidate.candidateId ? editedPreview.bodyText : undefined,
      ),
  );
  return {
    items,
    noAction: EffectArray.every(items, item => item.recommendation === 'no_action'),
    reviewId: review.reviewId,
    revision: review.revision,
    ...(review.structuredCloseout ? {structuredCloseout: projectStructuredCloseout(review.structuredCloseout)} : {}),
    type: 'knowledge-delta',
    version: 1,
  };
}

function projectStructuredCloseout(value: StructuredCloseoutV1): StructuredCloseoutV1 {
  return {
    type: 'structured-closeout',
    version: 1,
    rationale: boundedText(value.rationale).text,
    constraints: EffectArray.map(value.constraints.slice(0, 32), item => boundedText(item).text),
    verificationPerformed: EffectArray.map(value.verificationPerformed.slice(0, 32), item => boundedText(item).text),
    knowledgeInvalidated: EffectArray.map(value.knowledgeInvalidated.slice(0, 32), item => boundedText(item).text),
    unresolvedRisks: EffectArray.map(value.unresolvedRisks.slice(0, 32), item => boundedText(item).text),
  };
}

function projectKnowledgeDeltaItemV1(
  review: CandidateReview,
  candidate: MemoryCandidate | LegacyMemoryCandidate,
  previewBodyText?: string,
): KnowledgeDeltaItemV1 {
  const candidateId = boundedText(candidate.candidateId);
  const bodyText = boundedText(previewBodyText ?? candidate.applyBodyText ?? candidate.proposedText);
  const comparisonReason = boundedText(candidate.reason);
  const project = boundedText(candidate.project ?? review.project);
  const targetContentHash = candidate.targetContentHash ? boundedText(candidate.targetContentHash) : undefined;
  const targetUri = candidate.targetUri ? boundedText(candidate.targetUri) : undefined;
  const topic = boundedText(candidate.topic ?? review.topic);
  const evidence = candidate.evidence ?? [];
  const sourceEvidence = EffectArray.map(evidence.slice(0, KNOWLEDGE_DELTA_V1_MAX_SOURCE_EVIDENCE), boundedText);
  const replacementSafety = candidate.replacementSafetyBaseline
    ? projectReplacementSafety(candidate, candidate.replacementSafetyBaseline, bodyText.text)
    : replacementSafetyRequiresFreshReview(candidate)
      ? {
          acknowledged: false as const,
          classification: 'review-required' as const,
          requiresExplicitApproval: true as const,
          sectionListTruncated: false as const,
          warning: replacementSafetyReviewRequiredWarning(candidate),
        }
      : undefined;
  return {
    candidateId: candidateId.text,
    comparison: candidate.comparison,
    comparisonReason: comparisonReason.text,
    confidence: candidate.confidence,
    mutationPreview: {
      bodyText: bodyText.text,
      ...(targetContentHash ? {expectedTargetContentHash: targetContentHash.text} : {}),
      operation: mutationOperation(candidate),
      ...(replacementSafety ? {replacementSafety} : {}),
      ...(targetUri ? {replaceUri: targetUri.text} : {}),
      truncated: bodyText.truncated || (targetContentHash?.truncated ?? false) || (targetUri?.truncated ?? false),
    },
    proposedDestination: {
      kind: candidate.kind,
      project: project.text,
      ...(targetUri ? {targetUri: targetUri.text} : {}),
      topic: topic.text,
    },
    recommendation: candidate.recommendation,
    sourceEvidence: EffectArray.map(sourceEvidence, evidence => evidence.text),
    state: candidate.state,
    truncated:
      candidateId.truncated ||
      comparisonReason.truncated ||
      project.truncated ||
      (targetContentHash?.truncated ?? false) ||
      (targetUri?.truncated ?? false) ||
      topic.truncated ||
      bodyText.truncated ||
      evidence.length > KNOWLEDGE_DELTA_V1_MAX_SOURCE_EVIDENCE ||
      EffectArray.some(sourceEvidence, evidence => evidence.truncated),
    type: knowledgeDeltaItemType(candidate),
  };
}

function projectReplacementSafety(
  candidate: MemoryCandidate | LegacyMemoryCandidate,
  baseline: NonNullable<MemoryCandidate['replacementSafetyBaseline']>,
  bodyText: string,
): KnowledgeDeltaReplacementSafetyV1 {
  const assessment = assessReplacementSafety(candidate.kind, baseline, bodyText);
  const acknowledged = candidate.applyAllowDestructiveReplacement === true;
  return {
    ...assessment,
    acknowledged,
    classification: assessment.destructiveLossRisk ? 'destructive-loss-risk' : 'preserving',
    requiresExplicitApproval: assessment.destructiveLossRisk && !acknowledged,
    sectionListTruncated: baseline.sectionListTruncated,
    ...(assessment.destructiveLossRisk ? {warning: replacementSafetyWarning(assessment)} : {}),
  };
}

export function replacementSafetyWarning(assessment: ReplacementSafetyAssessmentV1): string {
  const missingSections =
    assessment.missingSections.length === 0
      ? ''
      : ` Missing current sections: ${EffectArray.join(assessment.missingSections, ', ')}.`;
  return (
    `Destructive replacement risk: proposed body has ${assessment.proposedBodyCharacters} characters and ` +
    `${assessment.proposedNonEmptyLines} non-empty lines; the current target has ` +
    `${assessment.targetBodyCharacters} characters and ${assessment.targetNonEmptyLines} non-empty lines.` +
    `${missingSections} Merge continuity-critical detail into the replacement, or explicitly approve destructive loss ` +
    'after reading the current target.'
  );
}

function replacementSafetyRequiresFreshReview(
  candidate: Pick<MemoryCandidate, 'recommendation' | 'targetContentHash' | 'targetUri'>,
): boolean {
  return (
    candidate.recommendation !== 'no_action' &&
    candidate.targetContentHash !== undefined &&
    candidate.targetUri !== undefined
  );
}

function knowledgeDeltaItemType(
  candidate: Pick<MemoryCandidate, 'comparison' | 'categories' | 'recommendation'>,
): KnowledgeDeltaItemType {
  if (candidate.comparison !== 'new' || candidate.recommendation === 'no_action') {
    return 'context-repair-or-retirement';
  }
  if (candidate.categories.includes('handoff')) {
    return 'handoff-state';
  }
  if (candidate.categories.includes('decision') || candidate.categories.includes('invariant')) {
    return 'decision-or-invariant';
  }
  return 'preference';
}

function mutationOperation(
  candidate: Pick<MemoryCandidate, 'recommendation'>,
): KnowledgeDeltaMutationPreviewV1['operation'] {
  switch (candidate.recommendation) {
    case 'create':
      return 'create';
    case 'no_action':
      return 'no_action';
    case 'replace':
      return 'replace';
    case 'manual_review':
      return 'requires_explicit_operation';
  }
}

function boundedText(text: string): {readonly text: string; readonly truncated: boolean} {
  return text.length <= KNOWLEDGE_DELTA_V1_MAX_TEXT_CHARACTERS
    ? {text, truncated: false}
    : {text: Effect.pipe(text, EffectString.slice(0, KNOWLEDGE_DELTA_V1_MAX_TEXT_CHARACTERS)), truncated: true};
}
