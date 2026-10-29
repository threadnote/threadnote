import type {CodeMemoryLinkExpectedCodexClientV1} from './code-memory-link-agent-client-identity.js';
import type {CodeMemoryLinkInvocationAttestationV1} from './code-memory-link-attestation.js';
import type {CodeMemoryLinkAgentAbMetricsV1} from './code-memory-link-agent-ab-metrics.js';

export const CODE_MEMORY_LINK_AGENT_AB_VERSION = 1 as const;
export const CODE_MEMORY_LINK_AGENT_AB_BLIND_LABELS = ['X', 'Y', 'Z'] as const;
export const CODE_MEMORY_LINK_AGENT_AB_ARMS = ['anchored', 'task-only', 'no-memory'] as const;
export const CODE_MEMORY_LINK_AGENT_AB_MINIMUM_CLIENTS = 2 as const;
export const CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_CLIENTS = 8 as const;
export const CODE_MEMORY_LINK_AGENT_AB_MINIMUM_HIDDEN_TASKS = 12 as const;
export const CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_TASKS = 16 as const;
export const CODE_MEMORY_LINK_AGENT_AB_MINIMUM_HIDDEN_SCENARIO_FAMILIES = 2 as const;
export const CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILIES = 9 as const;
export const CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_TASKS = 64 as const;
export const CODE_MEMORY_LINK_AGENT_AB_MINIMUM_ADHERENCE_DELTA_PERCENTAGE_POINTS = 10 as const;
export const CODE_MEMORY_LINK_AGENT_AB_MINIMUM_FIRST_USE_REDUCTION_PERCENT = 20 as const;
export const CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_REGRESSION_PERCENTAGE_POINTS = 0 as const;
export const CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_PASS_RATE = 0.9 as const;
export const CODE_MEMORY_LINK_AGENT_AB_MINIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILY_PASS_RATE = 1 as const;
export const CODE_MEMORY_LINK_AGENT_AB_MAXIMUM_NEGATIVE_CONTROL_SCENARIO_FAMILY_REGRESSION_EVENT_RATE = 0 as const;
export const CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION = 'sha256-counterbalanced-v1' as const;

export type CodeMemoryLinkAgentAbBlindLabel = (typeof CODE_MEMORY_LINK_AGENT_AB_BLIND_LABELS)[number];
export type CodeMemoryLinkAgentAbArm = (typeof CODE_MEMORY_LINK_AGENT_AB_ARMS)[number];
export type CodeMemoryLinkAgentAbScenarioFamily = 'hidden:anchored-only' | 'hidden:lexical' | `control:${string}`;

export interface CodeMemoryLinkAgentAbAssignmentV1 {
  readonly assignmentHash: string;
  readonly fixtureHash: string;
  readonly labels: Readonly<Record<CodeMemoryLinkAgentAbBlindLabel, CodeMemoryLinkAgentAbArm>>;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_AB_VERSION;
}

export interface CodeMemoryLinkAgentAbManifestV1 {
  readonly adjudicationArtifactHash: string;
  readonly assignmentHash: string;
  readonly candidate: {
    /** SHA-256 of the exact managed Threadnote executable used by every external trial. */
    readonly buildIdentityHash: string;
    readonly commit: string;
    readonly dirty: false;
  };
  readonly clients: readonly CodeMemoryLinkAgentAbManifestClientV1[];
  readonly evaluatorVersion: string;
  readonly experimentId: string;
  readonly fixtureHash: string;
  /** Clean protocol checkout that governs the harness independently from the evaluated candidate. */
  readonly harnessGovernanceCommit?: string;
  readonly judgeVersion: string;
  readonly manifestHash: string;
  readonly schedule: readonly CodeMemoryLinkAgentAbScheduleEntryV1[];
  readonly scheduleAlgorithmVersion: typeof CODE_MEMORY_LINK_AGENT_AB_SCHEDULE_ALGORITHM_VERSION;
  readonly scheduleSeed: string;
  /** Content hash of the exact sealed task, packet, rubric, and fixture corpus. */
  readonly suiteHash: string;
  readonly tasks: readonly CodeMemoryLinkAgentAbManifestTaskV1[];
  readonly version: typeof CODE_MEMORY_LINK_AGENT_AB_VERSION;
}

export interface CodeMemoryLinkAgentAbManifestClientV1 {
  readonly clientId: string;
  readonly configurationProjectionHash: string;
  readonly environmentPolicyHash: string;
  readonly executionBundleHash: string;
  readonly expectedClient: CodeMemoryLinkExpectedCodexClientV1;
  readonly implementationDescriptorHash: string;
}

export interface CodeMemoryLinkAgentAbScheduleEntryV1 {
  readonly armPosition: 1 | 2 | 3;
  readonly blindLabel: CodeMemoryLinkAgentAbBlindLabel;
  readonly clientId: string;
  readonly runNonce: string;
  readonly runOrder: number;
  readonly taskId: string;
}

export interface CodeMemoryLinkAgentAbManifestTaskV1 {
  readonly budget: {readonly steps: number; readonly tokens: number};
  readonly constraintTotal: number;
  readonly expectedResponseHashes: {
    readonly anchored: string;
    readonly noMemory: string;
    readonly taskOnly: string;
  };
  readonly packetHash: string;
  readonly rubricHash: string;
  /** Reviewed structural family; token-renamed tasks in one family are not independent population samples. */
  readonly scenarioFamily: CodeMemoryLinkAgentAbScenarioFamily;
  readonly taskId: string;
  readonly taskKind: 'hidden-constraint' | 'negative-control';
}

export interface CodeMemoryLinkAgentAbTrialV1 {
  readonly acceptedStaleOrHarmful: boolean;
  readonly adjudicationHash: string;
  readonly attestation: CodeMemoryLinkInvocationAttestationV1;
  /** Clean governance commit that allowlisted this manifest before the trial began. */
  readonly approvalCommit: string;
  readonly armPosition: 1 | 2 | 3;
  readonly assignmentHash: string;
  readonly blindLabel: CodeMemoryLinkAgentAbBlindLabel;
  readonly budget: {readonly steps: number; readonly tokens: number};
  readonly clientId: string;
  readonly constraintAdherence: {
    readonly satisfied: number;
    readonly total: number;
  };
  /** Mock receipts exercise import/scoring only and are excluded from release evidence. */
  readonly evidenceKind: 'external-agent' | 'mock';
  readonly firstUsefulMemoryUse: {
    readonly steps: number;
    readonly tokens: number;
  } | null;
  readonly fixtureHash: string;
  readonly manifestHash: string;
  readonly packetHash: string;
  /** Digest of the immediately preceding receipt in the frozen JSONL schedule, or null for run zero. */
  readonly previousReceiptDigest: string | null;
  readonly providerUsageHash: string;
  readonly rubricHash: string;
  readonly runNonce: string;
  readonly runOrder: number;
  readonly taskId: string;
  readonly taskKind: 'hidden-constraint' | 'negative-control';
  readonly taskPassed: boolean;
  readonly tokenAccounting: 'client-reported' | 'provider-reported' | 'unavailable';
  readonly totalTaskUsage: {readonly steps: number; readonly tokens: number};
  readonly trialId: string;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_AB_VERSION;
}

export type CodeMemoryLinkAgentAbTrialSummaryV1 = Omit<CodeMemoryLinkAgentAbTrialV1, 'attestation'>;
export type CodeMemoryLinkAgentAbClientTrialSummaryV1 = Omit<
  CodeMemoryLinkAgentAbTrialSummaryV1,
  'previousReceiptDigest' | 'trialId'
>;

export interface CodeMemoryLinkAgentAbResultV1 {
  readonly assignmentHash: string;
  readonly candidate: CodeMemoryLinkAgentAbManifestV1['candidate'];
  readonly evidence: {
    readonly approvedEvidence: boolean;
    readonly approvedManifest: boolean;
    readonly distinctClients: number;
    readonly eligibleExternalTrials: number;
    readonly excludedMockTrials: number;
    readonly externalEvidenceHash: string;
    readonly hiddenTasks: number;
    readonly manifestApprovalCommit: string | null;
    readonly negativeControlTasks: number;
    readonly pairedBlocks: number;
    readonly retainedEvidenceReceipts: number;
  };
  readonly fixtureHash: string;
  readonly gate: {
    readonly failures: readonly string[];
    readonly insufficiencies: readonly string[];
    readonly qualityFailures: readonly string[];
    readonly status: 'failed' | 'insufficient' | 'passed';
  };
  readonly manifestHash: string;
  readonly metrics: CodeMemoryLinkAgentAbMetricsV1;
  readonly suiteHash: string;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_AB_VERSION;
}
