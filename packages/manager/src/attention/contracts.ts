import type {
  CandidateCategory,
  CandidateComparison,
  CandidateRecommendation,
  CandidateReviewState,
} from '@threadnote/memory/candidate';
import type {ContextHealthReportV1} from '@threadnote/context/health';
import type {MemoryKind} from '@threadnote/memory/types';

export type ManagerRepositoryEvidenceUnavailableReasonV1 =
  'foreign-host' | 'manifest-unavailable' | 'project-not-configured' | 'repository-unavailable';

export type ManagerRepositoryEvidenceV1 =
  | {readonly state: 'available'}
  | {readonly reason: ManagerRepositoryEvidenceUnavailableReasonV1; readonly state: 'unavailable'};

export interface ManagerReviewCandidateV1 {
  readonly candidateId: string;
  readonly categories: readonly CandidateCategory[];
  readonly comparison: CandidateComparison;
  readonly confidence: number;
  readonly proposedText: string;
  readonly reason: string;
  readonly recommendation: CandidateRecommendation;
  readonly state: CandidateReviewState;
  readonly targetUri?: string;
}

export interface ManagerReviewInboxItemV1 {
  readonly candidates: readonly ManagerReviewCandidateV1[];
  readonly createdAt: string;
  readonly project: string;
  readonly reviewId: string;
  readonly revision: number;
  readonly task: string;
  readonly topic: string;
}

export interface ManagerReviewInboxResponseV1 {
  readonly items: readonly ManagerReviewInboxItemV1[];
  readonly pendingCount: number;
  readonly project: string;
  readonly version: 1;
}

export interface ManagerContextHealthCodePreviewV1 {
  readonly citationId: string;
  readonly excerpt?: string;
  readonly findingIds: readonly string[];
  readonly line?: number;
  readonly path: string;
  readonly targetLabel?: string;
  readonly evidence?: {
    readonly coverage: 'available' | 'ambiguous' | 'unavailable';
    readonly generation: string;
    readonly attemptedSteps: readonly string[];
    readonly excerpts: readonly {
      readonly content: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly excerptHash: string;
      readonly fileBytesHash: string;
      readonly provenance: 'current-verified' | 'historical-verified';
      readonly supportsCitation: boolean;
      readonly source: {readonly path: string; readonly sourceCommit: string; readonly sourceSnapshotId: string};
    }[];
  };
}

export interface ManagerContextHealthRecordPreviewV1 {
  readonly code: readonly ManagerContextHealthCodePreviewV1[];
  readonly excerpt: string;
  readonly kind: MemoryKind;
  readonly title: string;
  readonly topic?: string;
  readonly uri: string;
}

export type ManagerContextHealthResponseV1 = ContextHealthReportV1 & {
  readonly recordPreviews: readonly ManagerContextHealthRecordPreviewV1[];
  readonly repositoryEvidence: ManagerRepositoryEvidenceV1;
};

export type ManagerCitationRepairJobStatusV1 = 'completed' | 'failed' | 'running';

export interface ManagerCitationRepairJobV1 {
  readonly createdAt: string;
  readonly error?: string;
  readonly finishedAt?: string;
  readonly id: string;
  readonly progress: {
    readonly batch: number;
    readonly failedCount: number;
    readonly initialCitationCount?: number;
    readonly message: string;
    readonly pagesScanned: number;
    readonly phase: 'applying' | 'completed' | 'failed' | 'rebuilding' | 'scanning' | 'starting';
    readonly repairableCount: number;
    readonly repairedCount: number;
    readonly unresolvedCount: number;
  };
  readonly project: string;
  readonly status: ManagerCitationRepairJobStatusV1;
  readonly warning?: string;
}

export interface ManagerCitationRepairJobResponseV1 {
  readonly job: ManagerCitationRepairJobV1 | null;
}

export interface ManagerContextMaintenanceCaseV2 {
  readonly caseId: string;
  readonly project: string;
  readonly memoryId: string;
  readonly subjectUri?: string;
  readonly archivedUri?: string;
  readonly family: string;
  readonly slot: string;
  readonly evidenceRevision: string;
  readonly disposition:
    | 'queued'
    | 'repairing'
    | 'waiting-evidence'
    | 'needs-decision'
    | 'resolved'
    | 'retired'
    | 'historical'
    | 'deferred-policy';
  readonly reason: string;
  readonly causeKey?: string;
  readonly repositoryId?: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly lastChecked: string;
  readonly attemptCount: number;
  readonly nextAttemptAt?: string;
  readonly events: readonly {readonly at: string; readonly reason: string}[];
}

export interface ManagerContextMaintenanceReceiptV2 {
  readonly receiptId: string;
  readonly project: string;
  readonly subjectUri: string;
  readonly archivedUri?: string;
  readonly postHash: string;
  readonly timestamp: string;
  readonly state: 'applying' | 'applied' | 'undone' | 'conflict';
}

export interface ManagerContextMaintenanceStatusV2 {
  readonly version: 2;
  readonly paused: boolean;
  readonly state: 'idle' | 'running' | 'waiting-evidence' | 'needs-decision' | 'failed';
  readonly generation: string;
  readonly projects: readonly {
    readonly project: string;
    readonly generation: string;
    readonly cursor: number;
    readonly eligible: number;
    readonly checked: number;
    readonly eligibleCitations: number;
    readonly checkedCitations: number;
  }[];
  readonly cases: readonly ManagerContextMaintenanceCaseV2[];
  readonly receipts: readonly ManagerContextMaintenanceReceiptV2[];
  readonly counts?: Readonly<Record<string, number>>;
  readonly groups?: readonly {
    readonly causeKey: string;
    readonly project: string;
    readonly disposition: ManagerContextMaintenanceCaseV2['disposition'];
    readonly reason: string;
    readonly repositoryId?: string;
    readonly affectedMemories: number;
    readonly nextAttemptAt?: string;
  }[];
  readonly omittedCases?: number;
  readonly omittedReceipts?: number;
  readonly page?: {readonly generation: string; readonly caseNextCursor?: string; readonly receiptNextCursor?: string};
  readonly lastProgressAt?: string;
  readonly error?: {readonly reason: string; readonly at: string};
}

export interface ManagerContextMaintenancePacketV2 {
  readonly version: 2;
  readonly caseId: string;
  readonly project: string;
  readonly family?: string;
  readonly slot?: string;
  readonly callerCwd?: string;
  readonly memoryUri?: string;
  readonly evidenceRevision: string;
  readonly expectedContentHash: string;
  readonly reason: string;
  readonly choices: readonly string[];
  readonly allowedOperations: readonly string[];
  readonly instructions: string;
  readonly evidence?: ManagerContextHealthCodePreviewV1['evidence'];
  readonly evidenceSelectors?: readonly {
    readonly caseId: string;
    readonly memoryUri: string;
    readonly citationId: string;
    readonly anchorId: string;
  }[];
  readonly omittedEvidenceSelectors?: number;
  readonly ownerProposal?: {
    readonly proposalRevision: string;
    readonly expectedContentHash: string;
    readonly selectedEdits: readonly {
      readonly operation: string;
      readonly relation: {readonly type: string; readonly uri: string};
    }[];
    readonly omittedEdits: number;
    readonly publication: {readonly instructions: string};
  };
}
