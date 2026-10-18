import type {
  TopicMaintenanceDraftV1,
  TopicGenerationSummaryV1,
  TopicMaintenanceParagraphCoverageV1,
} from '@threadnote/memory/topic-maintenance-draft';
import type {TopicMaintenanceParagraphV1, TopicMaintenanceDependencyV1} from '@threadnote/memory/topic-maintenance';

export type ManagerTopicReviewActionV1 =
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
