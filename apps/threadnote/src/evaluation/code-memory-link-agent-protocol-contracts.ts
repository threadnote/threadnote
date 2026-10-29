import type {CanonicalJsonValue} from './code-memory-link-agent-protocol-primitives.js';
import {CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION} from './code-memory-link-agent-client-identity.js';
export type AppServerItemStatus = 'completed' | 'declined' | 'failed' | 'inProgress';
import type {
  CodeMemoryLinkExpectedCodexClientV1,
  CodeMemoryLinkProxyToolV1,
} from './code-memory-link-agent-client-identity.js';
import type {AllowedItemType, IgnoredTurnMethod} from './code-memory-link-agent-protocol-items.js';
import type * as contextBriefProtocol from './code-memory-link-context-brief-protocol.js';

export const CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION = 1 as const;
export const CODE_MEMORY_LINK_SEALED_HIDDEN_TASKS = 12 as const;
export const CODE_MEMORY_LINK_SEALED_NEGATIVE_CONTROL_TASKS = 16 as const;

export const CODE_MEMORY_LINK_TASK_KINDS = ['hidden-constraint', 'negative-control'] as const;
export const CODE_MEMORY_LINK_ARM_POLICIES = ['anchored', 'task-only', 'no-memory'] as const;
export const CODE_MEMORY_LINK_BLIND_LABELS = ['X', 'Y', 'Z'] as const;
export const CODE_MEMORY_LINK_PREDICATE_ROLES = [
  'constraint',
  'harmful-acceptance',
  'memory-exclusive',
  'qualifying-action',
  'task-pass',
] as const;
export const CODE_MEMORY_LINK_QUALIFYING_ACTION_ITEM_TYPES = ['commandExecution', 'fileChange'] as const;
export const CODE_MEMORY_LINK_STATIC_ASSERTION_KINDS = [
  'json-equals',
  'utf8-contains',
  'utf8-equals',
  'utf8-not-contains',
] as const;

export type CodeMemoryLinkTaskKind = (typeof CODE_MEMORY_LINK_TASK_KINDS)[number];
export type CodeMemoryLinkArmPolicy = (typeof CODE_MEMORY_LINK_ARM_POLICIES)[number];
export type CodeMemoryLinkBlindLabel = (typeof CODE_MEMORY_LINK_BLIND_LABELS)[number];
export type CodeMemoryLinkPredicateRole = (typeof CODE_MEMORY_LINK_PREDICATE_ROLES)[number];
export type CodeMemoryLinkQualifyingActionItemType = (typeof CODE_MEMORY_LINK_QUALIFYING_ACTION_ITEM_TYPES)[number];
export type CodeMemoryLinkStaticAssertionKind = (typeof CODE_MEMORY_LINK_STATIC_ASSERTION_KINDS)[number];
export type CodeMemoryLinkJsonValue = CanonicalJsonValue;

export interface CodeMemoryLinkArtifactV1 {
  readonly artifactId: string;
  readonly sha256: string;
}

export interface CodeMemoryLinkFixtureV1 {
  readonly artifacts: readonly CodeMemoryLinkArtifactV1[];
  readonly fixtureHash: string;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION;
}

export interface CodeMemoryLinkJudgeV1 {
  readonly artifacts: readonly CodeMemoryLinkArtifactV1[];
  readonly judgeHash: string;
  readonly judgeVersion: string;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION;
}

export interface CodeMemoryLinkTaskPacketV1 {
  readonly budget: {readonly steps: number; readonly tokens: number};
  readonly fixtureHash: string;
  readonly packetHash: string;
  readonly prompt: string;
  readonly taskId: string;
  readonly taskKind: CodeMemoryLinkTaskKind;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION;
}

export interface CodeMemoryLinkPredicateV1 {
  readonly assertion:
    | {
        readonly artifactId: string;
        readonly expected: CodeMemoryLinkJsonValue;
        readonly kind: 'json-equals';
      }
    | {
        readonly artifactId: string;
        readonly expected: string;
        readonly kind: 'utf8-contains' | 'utf8-equals' | 'utf8-not-contains';
      };
  readonly expected: boolean;
  readonly predicateId: string;
  readonly roles: readonly CodeMemoryLinkPredicateRole[];
}

/** Content-addressed judge input. Filesystem paths and links are deliberately not part of this contract. */
export interface CodeMemoryLinkStaticArtifactInputV1 {
  readonly artifactId: string;
  readonly content: string;
  readonly mediaType: 'application/json' | 'text/plain';
  readonly sha256: string;
}

export interface CodeMemoryLinkRubricV1 {
  readonly fixtureHash: string;
  /** Domain-separated SHA-256 digests of the citation ids, never raw citation ids. */
  readonly goldCitationDigests: readonly string[];
  readonly predicates: readonly CodeMemoryLinkPredicateV1[];
  readonly qualifyingActionItemTypes: readonly CodeMemoryLinkQualifyingActionItemType[];
  readonly rubricHash: string;
  readonly taskId: string;
  readonly taskKind: CodeMemoryLinkTaskKind;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION;
}

export interface CodeMemoryLinkSuiteTaskV1 {
  readonly packetHash: string;
  readonly rubricHash: string;
  readonly taskId: string;
  readonly taskKind: CodeMemoryLinkTaskKind;
}

export interface CodeMemoryLinkSealedSuiteV1 {
  readonly fixture: CodeMemoryLinkFixtureV1;
  readonly judge: CodeMemoryLinkJudgeV1;
  readonly suiteHash: string;
  readonly suiteId: string;
  readonly tasks: readonly CodeMemoryLinkSuiteTaskV1[];
  readonly version: typeof CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION;
}

export interface CodeMemoryLinkArmPacketV1 {
  readonly armPacketHash: string;
  readonly assignmentHash: string;
  readonly blindLabel: CodeMemoryLinkBlindLabel;
  readonly fixtureHash: string;
  readonly packetHash: string;
  readonly policy: CodeMemoryLinkArmPolicy;
  readonly rubricHash: string;
  readonly runNonce: string;
  readonly taskId: string;
  readonly taskKind: CodeMemoryLinkTaskKind;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION;
}

export interface CodeMemoryLinkPredicateObservationV1 {
  readonly predicateId: string;
  readonly value: boolean;
}

export interface CodeMemoryLinkStaticObservationV1 {
  readonly artifactHash: string;
  readonly fixtureHash: string;
  readonly observationHash: string;
  readonly predicates: readonly CodeMemoryLinkPredicateObservationV1[];
  readonly qualifyingActionItemDigest: string | null;
  readonly rubricHash: string;
  readonly taskId: string;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION;
}

export interface CodeMemoryLinkStaticJudgmentV1 {
  readonly acceptedStaleOrHarmful: boolean;
  readonly adjudicationHash: string;
  readonly artifactHash: string;
  readonly constraintAdherence: {
    readonly satisfied: number;
    readonly total: number;
  };
  readonly memoryExclusiveSatisfied: boolean;
  readonly observationHash: string;
  readonly qualifyingActionItemDigest: string | null;
  readonly qualifyingActionQualified: boolean;
  readonly rubricHash: string;
  readonly taskId: string;
  readonly taskPassed: boolean;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION;
}

export interface CodeMemoryLinkProviderUsageV1 {
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

export interface CodeMemoryLinkCodexAppServerProjectionV1 {
  readonly acceptedStaleOrHarmful: boolean;
  readonly adjudicationHash: string;
  readonly appServerVersion: typeof CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION;
  readonly contextBriefCalls: readonly contextBriefProtocol.CodeMemoryLinkCodexContextBriefCallProjectionV1[];
  readonly contextBriefProtocolAdhered: boolean;
  readonly constraintAdherence: {
    readonly satisfied: number;
    readonly total: number;
  };
  readonly effectiveModel: string;
  readonly evidenceHash: string;
  readonly eventCount: number;
  readonly firstUsefulMemoryUse: {
    readonly steps: number;
    readonly tokens: number;
  } | null;
  readonly itemCounts: Readonly<Record<AllowedItemType, number>>;
  readonly modelProviderDigest: string;
  readonly projectionHash: string;
  readonly providerUsage: CodeMemoryLinkProviderUsageV1;
  readonly providerUsageHash: string;
  readonly proxyToolDigest: string;
  readonly reasoningEffortDigest: string;
  readonly taskPassed: boolean;
  readonly threadIdDigest: string;
  readonly totalTaskUsage: {readonly steps: number; readonly tokens: number};
  readonly turnIdDigest: string;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION;
}

export type CodeMemoryLinkCodexTraceCheckpointV1 =
  | {
      readonly method: 'turn/started';
      readonly ordinal: number;
    }
  | {
      readonly itemIdDigest: string;
      readonly itemType: Exclude<AllowedItemType, 'mcpToolCall'>;
      readonly method: 'item/started';
      readonly ordinal: number;
      readonly status: AppServerItemStatus | null;
    }
  | {
      readonly itemIdDigest: string;
      readonly itemType: 'mcpToolCall';
      readonly method: 'item/started';
      readonly ordinal: number;
      readonly requestDigest: string;
      readonly status: AppServerItemStatus | null;
    }
  | {
      readonly itemIdDigest: string;
      readonly itemType: Exclude<AllowedItemType, 'mcpToolCall'>;
      readonly method: 'item/completed';
      readonly ordinal: number;
      readonly status: AppServerItemStatus | null;
    }
  | {
      readonly itemIdDigest: string;
      readonly itemType: 'mcpToolCall';
      readonly method: 'item/completed';
      readonly ordinal: number;
      readonly proxyReceipt: contextBriefProtocol.CodeMemoryLinkContextBriefProxyReceiptV1 | null;
      readonly requestDigest: string;
      readonly response: contextBriefProtocol.CodeMemoryLinkContextBriefResponseReceiptV1 | null;
      readonly status: 'completed' | 'failed';
      readonly succeeded: boolean;
    }
  | {
      readonly method: 'thread/tokenUsage/updated';
      readonly ordinal: number;
      readonly total: CodeMemoryLinkProviderUsageV1;
    }
  | {
      readonly method: 'turn/completed';
      readonly ordinal: number;
      readonly status: 'completed';
    }
  | {
      readonly method: IgnoredTurnMethod;
      readonly ordinal: number;
    };

export type CodeMemoryLinkCodexTraceCheckpointWithoutOrdinalV1 =
  CodeMemoryLinkCodexTraceCheckpointV1 extends infer Checkpoint
    ? Checkpoint extends {readonly ordinal: number}
      ? Omit<Checkpoint, 'ordinal'>
      : never
    : never;

export interface CodeMemoryLinkCodexAppServerEvidenceV1 {
  readonly approvalReceipts: readonly CodeMemoryLinkAppServerApprovalReceiptV1[];
  readonly appServerVersion: typeof CODE_MEMORY_LINK_CODEX_APP_SERVER_VERSION;
  readonly checkpoints: readonly CodeMemoryLinkCodexTraceCheckpointV1[];
  readonly effectiveModel: string;
  readonly eventCount: number;
  readonly evidenceHash: string;
  readonly modelProviderDigest: string;
  readonly preTurn: {
    readonly proxyStartupNotifications: number;
    readonly remoteControlDisabled: true;
    readonly threadStarted: true;
  };
  readonly proxyToolDigest: string;
  readonly qualifyingActionItemDigest: string | null;
  readonly reasoningEffortDigest: string;
  readonly rubricHash: string;
  readonly runBindingHash: string;
  readonly staticArtifactSetHash: string;
  readonly staticArtifacts: readonly CodeMemoryLinkStaticArtifactInputV1[];
  readonly staticObservationHash: string;
  readonly threadIdDigest: string;
  readonly turnIdDigest: string;
  readonly version: typeof CODE_MEMORY_LINK_AGENT_PROTOCOL_VERSION;
}

export interface CodeMemoryLinkCodexAppServerTraceInputV1 {
  readonly approvalReceipts: readonly unknown[];
  readonly events: readonly unknown[];
  readonly expectedClient: CodeMemoryLinkExpectedCodexClientV1;
  readonly proxyTool: CodeMemoryLinkProxyToolV1;
  readonly qualifyingActionItemId: string | null;
  readonly rubric: unknown;
  readonly runBindingHash: string;
  readonly staticArtifacts: readonly unknown[];
  readonly threadStartResponse: unknown;
}

export interface CodeMemoryLinkAppServerApprovalReceiptV1 {
  readonly itemIdDigest: string;
  readonly itemType: 'commandExecution' | 'fileChange';
  readonly requestDigest: string;
}
