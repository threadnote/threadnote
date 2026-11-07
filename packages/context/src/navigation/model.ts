import type {CodeGraphRelation} from '@threadnote/graph/types';

export const NAVIGATION_ROLES = ['entrypoint', 'implementation', 'effects', 'tests'] as const;
export type NavigationRole = (typeof NAVIGATION_ROLES)[number];
export const NAVIGATION_INPUT_LIMITS = {
  candidates: 24,
  links: 64,
  sources: 32,
  anchors: 8,
  followUps: 2,
  gaps: 24,
  stringBytes: 65_536,
  totalStringBytes: 1_048_576,
} as const;

export interface NavigationScope {
  readonly repository: string;
  readonly worktree: string;
  readonly project: string;
  readonly view: {
    readonly kind: 'disk' | 'overlay' | 'editor';
    readonly id: string;
    readonly owner: string;
    readonly epoch: number;
  };
}

export type NavigationFreshness = 'verified-current' | 'stale' | 'deferred' | 'unverified';
export type NavigationEvidenceBasis = 'qualified-semantic' | 'structural' | 'inspected-source' | 'inference' | 'memory';

export interface NavigationSource extends NavigationScope {
  readonly id: string;
  readonly path: string;
  readonly contentHash: string;
  readonly freshness: NavigationFreshness;
  readonly snapshot?: string;
  /** Encoded once by the semantic admission boundary; assembly preserves it without reserialization. */
  readonly semantic?: {readonly observationKey: string; readonly observationJson: string};
}

export interface NavigationSpan {
  readonly startLine: number;
  readonly endLine: number;
}

/** Admitted source facts describe possible code behavior, never an observed runtime action. */
export interface NavigationPossibleEffect {
  readonly kind: 'in-memory' | 'durable-write' | 'external';
  readonly target: string;
  readonly condition?: string;
}

/** Internal normalized evidence. Source-fact admission and semantic qualification belong to the producer. */
export interface NavigationCandidate extends NavigationSpan {
  readonly id: string;
  readonly sourceId: string;
  readonly roles: readonly NavigationRole[];
  readonly reason: string;
  readonly relevance: number;
  readonly basis: readonly NavigationEvidenceBasis[];
  readonly support: 'evidenced' | 'candidate';
  readonly possibleEffect?: NavigationPossibleEffect;
  readonly testAssociation?: 'source-supported' | 'name-only';
}

export interface NavigationLink {
  readonly from: string;
  readonly to: string;
  readonly relation: CodeGraphRelation;
  readonly basis: NavigationEvidenceBasis;
  /** Explicit proof from the owning evidence join; matching names or endpoints do not supply it. */
  readonly compatibility: 'verified' | 'unknown' | 'conflict';
  readonly reason: string;
}

export interface NavigationRoleGap {
  readonly role: NavigationRole;
  readonly status: 'unknown' | 'unavailable' | 'omitted' | 'not-applicable';
  readonly reason: string;
  /** Required for an affirmative not-applicable result; absence is insufficient. */
  readonly sourceProof?: {readonly sourceId: string; readonly span: NavigationSpan};
}

export interface NavigationAcquisition {
  readonly kind: 'read-source' | 'query';
  readonly selector: string;
  readonly reason: string;
}

export interface NavigationInput {
  readonly scope: NavigationScope;
  readonly target:
    {readonly kind: 'task'} | {readonly kind: 'anchors' | 'ambiguous'; readonly candidateIds: readonly string[]};
  readonly candidates: readonly NavigationCandidate[];
  readonly sources: readonly NavigationSource[];
  readonly links: readonly NavigationLink[];
  readonly coverage: {
    readonly status: 'complete' | 'partial' | 'empty' | 'unsupported' | 'unavailable' | 'timeout';
    readonly description: string;
  };
  readonly roleGaps?: readonly NavigationRoleGap[];
  readonly gaps?: readonly string[];
  readonly followUps?: readonly NavigationAcquisition[];
}

export interface NavigationNode extends NavigationCandidate {
  readonly freshness: NavigationFreshness;
}

export interface NavigationRoleResult {
  readonly role: NavigationRole;
  readonly status: 'supported' | NavigationRoleGap['status'];
  readonly nodeIds: readonly string[];
  readonly candidateIds: readonly string[];
  readonly reason?: string;
  readonly sourceProof?: NavigationRoleGap['sourceProof'];
}

export interface NavigationAnswerV1 {
  readonly version: 1;
  readonly scope: NavigationScope;
  readonly target: NavigationInput['target'];
  readonly outcome: 'ok' | 'partial' | 'ambiguous' | 'unresolved' | 'conflict' | 'empty' | 'unavailable' | 'timeout';
  readonly nodes: readonly NavigationNode[];
  readonly links: readonly NavigationLink[];
  readonly sources: readonly NavigationSource[];
  readonly roles: readonly NavigationRoleResult[];
  readonly coverage: NavigationInput['coverage'];
  readonly gaps: readonly string[];
  readonly followUps: readonly NavigationAcquisition[];
}
