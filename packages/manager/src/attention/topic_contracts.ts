import type {
  TopicMaintenanceDraftV1,
  TopicGenerationSummaryV1,
  TopicMaintenanceParagraphCoverageV1,
} from '@threadnote/memory/topic-maintenance-draft';
import type {TopicMaintenanceParagraphV1, TopicMaintenanceDependencyV1} from '@threadnote/memory/topic-maintenance';
import type {AutomaticMaintenanceAssessment} from '@threadnote/memory/automatic-maintenance';
import type {
  AutomaticMaintenanceDraftProposalV2,
  AutomaticMaintenanceReviewEvidenceV3,
} from '@threadnote/memory/topic-maintenance-draft';
import type {ReviewedMemorySupportV1} from '@threadnote/memory/reviewed-support';

/** Presentation only: preparation and review capabilities remain owned by the existing controllers. */
export interface ManagerAutomaticMemoryItem {
  readonly uri: string;
  readonly title: string;
  readonly targetHash: string;
  readonly state:
    | 'preparing'
    | 'queued'
    | 'generating'
    | 'waiting-model'
    | 'waiting-budget'
    | 'paused'
    | 'policy'
    | 'retry'
    | 'failed'
    | 'ready'
    | 'reviewed'
    | 'unknown'
    | 'deferred'
    | 'verification';
  readonly reason?: string;
  readonly nextEligibleAt?: number;
  readonly retryCount?: number;
  readonly reviewId?: string;
  readonly evidenceRevision?: string;
  readonly coverage: AutomaticMaintenanceAssessment['coverage'];
  readonly paragraphs: readonly {
    readonly ordinal: number;
    readonly role: string;
    readonly authority: string;
    readonly support: string;
  }[];
  readonly route: 'personal-review' | 'shared-owner-review' | 'read-only' | 'excluded';
  readonly legacyUncited: boolean;
  readonly canGenerate?: boolean;
}
export interface ManagerAutomaticMemoryStatus {
  readonly version: 1;
  readonly project: string;
  readonly items: readonly ManagerAutomaticMemoryItem[];
  readonly omitted: number;
  readonly incomplete?: boolean;
  readonly unavailableRecords?: number;
  readonly nextCursor?: string;
}
export interface ManagerAutomaticReview {
  readonly version: 1;
  readonly kind: 'automatic-memory-review';
  readonly project: string;
  readonly reviewId: string;
  readonly revision: number;
  readonly state: ManagerTopicReviewV1['state'];
  readonly targetUri: string;
  readonly targetHash: string;
  readonly evidenceRevision: string;
  readonly purpose: 'automatic' | 'manual-edit';
  readonly acceptedBody: string;
  readonly proposal: AutomaticMaintenanceDraftProposalV2;
  readonly sourceEvidence: readonly AutomaticMaintenanceReviewEvidenceV3[];
  readonly coverage: AutomaticMaintenanceAssessment['coverage'];
  readonly approval?: {
    readonly stage: 'preview' | 'parked' | 'prepared' | 'written' | 'conflict';
    readonly reviewRevision: number;
    readonly approvalDigest: string;
    readonly content: string;
    readonly contentHash: string;
    readonly metadataDiff: readonly {readonly field: string; readonly beforeHash: string; readonly afterHash: string}[];
    readonly reviewedSupport: ReviewedMemorySupportV1;
  };
  readonly canApply: boolean;
  readonly canFinishVerification: boolean;
  /** True only after exact readback and persisted writer/maintenance completion. */
  readonly verified: boolean;
  readonly ownerProposal?: {readonly instructions: string; readonly publicationApprovalRequired: boolean};
}
export type ManagerAutomaticReviewResponse = ManagerAutomaticReview | ManagerTopicReviewRecoveryV1;

/** Recovery metadata never carries accepted memory, source, proposal or approval text. */
export interface ManagerTopicReviewRecoveryV1 {
  readonly version: 1;
  readonly kind: 'topic-maintenance-recovery';
  readonly project: string;
  readonly reviewId: string;
  readonly revision: number;
  readonly state: ManagerTopicReviewV1['state'];
  readonly caseId?: string;
  readonly recovery?: {readonly action: 'reject'};
}
export type ManagerTopicReviewResponseV1 = ManagerTopicReviewV1 | ManagerTopicReviewRecoveryV1;

/** The exact source observation accepted by a server-confirmed completed write. */
export interface ManagerTopicReviewAppliedV1 {
  readonly project: string;
  readonly caseId?: string;
  readonly evidenceRevision: string;
  readonly targetUri?: string;
  readonly targetHash?: string;
  readonly resolvedCitationIds?: readonly string[];
}

export type ManagerTopicReviewActionV1 =
  | {
      readonly action: 'capture';
      readonly project: string;
      readonly caseId: string;
      readonly expectedContentHash: string;
      readonly observationRevision: string;
      readonly inspectionDigest: string;
      readonly fragmentStart: number;
      readonly fragmentEnd: number;
      readonly retentionDays?: number;
      readonly approved: true;
    }
  | {
      readonly action: 'generate' | 'regenerate';
      readonly project: string;
      readonly caseId: string;
      readonly backend: 'local-ai' | 'effect-ai';
      readonly modelId: string;
    }
  | {
      readonly action: 'preview';
      readonly project: string;
      readonly reviewId: string;
      readonly revision: number;
      readonly editedDraftJson?: string;
    }
  | {
      readonly action: 'apply';
      readonly project: string;
      readonly reviewId: string;
      readonly revision: number;
      readonly approvalDigest: string;
      readonly approved: true;
    }
  | {
      readonly action: 'reject' | 'defer' | 'resume';
      readonly project: string;
      readonly reviewId: string;
      readonly revision: number;
      readonly caseId?: string;
    };

/** A deliberately narrow projection of the private CandidateReview. */
export interface ManagerTopicReviewV1 {
  readonly version: 1;
  readonly kind: 'topic-maintenance';
  readonly sourceKind?: 'code' | 'obsidian';
  readonly project: string;
  readonly reviewId: string;
  readonly revision: number;
  readonly state: 'pending' | 'deferred' | 'rejected' | 'applying' | 'applied' | 'conflict';
  readonly topic: string;
  readonly caseId?: string;
  /** Whether this case still observes the evidence revision used to generate the review. */
  readonly caseObservationMatches: boolean;
  readonly targetUri: string;
  readonly targetHash: string;
  readonly acceptedBody: string;
  readonly observationRevision: string;
  /** Old accepted citation slots refreshed by this exact written approval. */
  readonly resolvedCitationIds?: readonly string[];
  readonly coverage: 'declared-only';
  readonly paragraphCoverage?: TopicMaintenanceParagraphCoverageV1;
  readonly generation: {
    readonly origin: 'model' | 'manual';
    readonly observation?: TopicGenerationSummaryV1;
    readonly agent: string;
    readonly model: string;
    readonly attempts: number;
    readonly usage:
      | {readonly status: 'unavailable'}
      | {readonly status: 'measured'; readonly inputTokens: number; readonly outputTokens: number};
  };
  readonly draft: TopicMaintenanceDraftV1;
  readonly proposal: {
    readonly body: string;
    readonly finalBodyHash: string;
    readonly changedOrdinals: readonly number[];
  };
  readonly paragraphs: readonly TopicMaintenanceParagraphV1[];
  readonly additionalDependencies: readonly TopicMaintenanceDependencyV1[];
  readonly support: readonly {
    readonly handleId: string;
    readonly citationId: string;
    readonly variant: 'historical' | 'current';
    readonly path: string;
    readonly provenance: 'historical-verified' | 'current-verified';
  }[];
  readonly warnings: readonly string[];
  readonly approval?: {
    readonly stage: 'preview' | 'parked' | 'prepared' | 'written' | 'conflict';
    readonly reviewRevision: number;
    readonly approvalDigest: string;
    readonly content: string;
    readonly contentHash: string;
    readonly metadataDiff: readonly {readonly field: string; readonly beforeHash: string; readonly afterHash: string}[];
  };
  readonly canApply: boolean;
  readonly canFinishVerification?: boolean;
  readonly blockingReason?: string;
}
