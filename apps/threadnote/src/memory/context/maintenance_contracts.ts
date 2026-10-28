import {Schema} from 'effect';
import type {MaintenanceSemanticProgress, MaintenanceWorkSchedule} from './maintenance_decisions.js';
import type {TopicMaintenanceCheckpoint} from './maintenance_topic.js';
import type {
  ContextHealthCaseDispositionV2,
  ContextMaintenanceSnapshotDiagnosticV1,
} from '@threadnote/context/health_maintenance';
import type {ContextMaintenanceInventoryPreparationV2} from './maintenance_inventory.js';
import type {MemoryRelation} from '@threadnote/memory/document';
import type {ContextHealthRepairProposalV1} from './health_repair.js';

/** Only acquisition failed; the publication callback has not started. */
export class MaintenancePauseFenceBusy extends Schema.TaggedError<MaintenancePauseFenceBusy>()(
  'MaintenancePauseFenceBusy',
  {},
) {}

export class ContextMaintenanceBusy extends Schema.TaggedError<ContextMaintenanceBusy>()('ContextMaintenanceBusy', {}) {
  override readonly message =
    'Context maintenance is busy. No protected operation started. Retry shortly; if busy persists, let current Threadnote work finish before retrying.';
}

export function contextMaintenanceBusyResult() {
  return {
    outcome: 'busy' as const,
    code: 'context-maintenance-busy' as const,
    retryable: true as const,
    progress: 'not-started' as const,
    error: ContextMaintenanceBusy.make({}).message,
  };
}

export interface MaintenanceState extends ContextMaintenanceStatusV2 {
  readonly checkpoints: Readonly<Record<string, WorkCheckpoint>>;
  readonly lastProject?: string;
  readonly lastTaskByProject?: Readonly<Record<string, string>>;
  readonly lastWakeAt?: string;
  readonly policyOverrides?: Readonly<Record<string, string>>;
  readonly decisionCheckpoints?: Readonly<Record<string, string>>;
  readonly semanticProgress?: Readonly<Record<string, MaintenanceSemanticProgress>>;
  readonly workSchedule?: MaintenanceWorkSchedule;
  readonly topicCheckpoints?: Readonly<Record<string, TopicMaintenanceCheckpoint>>;
}

export interface ContextMaintenanceReceiptV2 {
  readonly receiptId: string;
  readonly project: string;
  readonly subjectUri: string;
  readonly archivedUri?: string;
  readonly postHash: string;
  readonly timestamp: string;
  readonly state: 'applying' | 'applied' | 'undone' | 'conflict';
}

export interface ContextMaintenanceReadOptions {
  readonly limit?: number;
  readonly caseCursor?: string;
  readonly receiptCursor?: string;
  readonly caseId?: string;
  readonly receiptId?: string;
}

/** A bounded readable-resource observation is never proof that an unobserved target is absent. */
export interface ContextMaintenanceRelationResourceObservation {
  readonly uri: string;
  readonly sourceHash?: string;
  readonly memoryId?: string;
  readonly status?: string;
}

export interface ContextMaintenanceRelationEvidence {
  readonly completeness: 'selected-only';
  readonly provenance: 'bounded-selected-resource-read';
  readonly subject: ContextMaintenanceRelationResourceObservation;
  /** Target observations exclude the subject, which the packet's existing subject fences re-read. */
  readonly observations: readonly ContextMaintenanceRelationResourceObservation[];
}

export interface ContextMaintenanceCaseV2 {
  readonly caseId: string;
  readonly project: string;
  readonly memoryId: string;
  readonly family: string;
  readonly slot: string;
  readonly evidenceRevision: string;
  readonly disposition: ContextHealthCaseDispositionV2;
  readonly reason: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly lastChecked: string;
  readonly attemptCount: number;
  readonly nextAttemptAt?: string;
  readonly wake?: {readonly kind: 'evidence-generation'; readonly revision: string};
  readonly citationId?: string;
  readonly subjectUri?: string;
  readonly archivedUri?: string;
  readonly omittedSubjects?: number;
  readonly omittedSources?: number;
  readonly anchorEvidence?: {readonly status: string; readonly coverage: string; readonly provenance?: string};
  readonly retirement?: {
    readonly citationId: string;
    readonly anchorSlot: string;
    readonly evidenceRevision: string;
    readonly expectedContentHash: string;
    readonly retiredAt: string;
    readonly reason: string;
    readonly provenance?: 'historical-verified' | 'unverified';
    readonly evidenceGeneration?: string;
    readonly attemptedSteps?: readonly string[];
  };
  readonly causeKey?: string;
  readonly repositoryId?: string;
  readonly subjectContentHashes?: readonly {readonly uri: string; readonly hash: string}[];
  readonly relationEvidence?: ContextMaintenanceRelationEvidence;
  readonly candidateReview?: {readonly reviewId: string; readonly revision: number; readonly candidateRevision: string};
  readonly sourceSnapshot?: {readonly cwd: string; readonly generation: string; readonly revision: string};
  readonly sourceSnapshots?: readonly {
    readonly uri: string;
    readonly cwd: string;
    readonly generation: string;
    readonly revision: string;
  }[];
  readonly events: readonly {readonly at: string; readonly reason: string}[];
}

export interface UndoJournal extends ContextMaintenanceReceiptV2 {
  readonly before: string;
  readonly after: string;
  readonly archiveProposal?: ContextHealthRepairProposalV1;
  readonly archiveCallerCwd?: string;
  readonly removed: readonly MemoryRelation[];
  readonly relationChanges?: readonly {
    readonly relation: MemoryRelation;
    readonly targetHash?: string;
    readonly successorHash?: string;
    readonly lineageHashes?: readonly string[];
  }[];
}

export interface WorkCheckpoint {
  readonly revision: string;
  readonly citationAdmissionVersion?: number;
  readonly checkedAt: string;
  readonly retryAt?: string;
  readonly checkedCitations?: number;
  readonly attemptedCitations?: number;
  readonly memoryHash?: string;
  readonly sourceEpoch?: string;
  readonly sourceRevision?: string;
  readonly inventoryComplete?: boolean;
}

export interface ContextMaintenanceStatusV2 {
  readonly version: 2;
  readonly paused: boolean;
  readonly state: 'idle' | 'running' | 'waiting-evidence' | 'needs-decision' | 'failed';
  readonly generation: string;
  readonly preparation?: ContextMaintenanceInventoryPreparationV2;
  readonly semanticCoverage?: readonly import('@threadnote/context/health_semantic').ContextHealthSemanticProgressCoverage[];
  readonly projects: readonly {
    readonly project: string;
    readonly generation: string;
    readonly cursor: number;
    readonly eligible: number;
    readonly checked: number;
    readonly eligibleCitations: number;
    readonly checkedCitations: number;
  }[];
  readonly cases: readonly ContextMaintenanceCaseV2[];
  readonly receipts: readonly ContextMaintenanceReceiptV2[];
  readonly counts?: Readonly<Record<string, number>>;
  readonly groups?: readonly {
    readonly causeKey: string;
    readonly project: string;
    readonly disposition: ContextHealthCaseDispositionV2;
    readonly reason: string;
    readonly affectedMemories: number;
  }[];
  readonly omittedCases?: number;
  readonly omittedReceipts?: number;
  readonly page?: {readonly generation: string; readonly caseNextCursor?: string; readonly receiptNextCursor?: string};
  readonly lastProgressAt?: string;
  readonly error?: {
    readonly reason: string;
    readonly at: string;
    readonly diagnostic?: ContextMaintenanceSnapshotDiagnosticV1;
  };
}
