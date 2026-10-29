import {Schema} from 'effect';
import type {DevSkillsMutationLease} from './lease.js';

export class DevSkillsError extends Schema.TaggedError<DevSkillsError, {readonly brand: unique symbol}>()(
  'DevSkillsError',
  {
    code: Schema.String,
    message: Schema.String,
  },
) {}

export type DevSkillsScope = 'user' | 'project' | 'local';
export type DevSkillsProfile = 'desktop' | 'codex-cloud-personal' | 'cursor-cloud-personal';
export type DevSkillsAction = 'install' | 'update' | 'remove';

export interface DevSkillsSelector {
  readonly agent: string;
  readonly scope?: DevSkillsScope;
  readonly cwd?: string;
  readonly profile?: DevSkillsProfile;
}

/** Catalog-derived locations. A public request never supplies its own destination. */
export interface DevSkillsTarget {
  readonly surfaceId: string;
  readonly agentId: string;
  readonly profile: DevSkillsProfile;
  readonly scope: DevSkillsScope;
  readonly cwd?: string;
  readonly skillRoot: string;
  readonly layout: 'directory' | 'flat';
  readonly discoveryRoots: readonly string[];
}

export interface DevSkillsIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export type DevSkillsInstallationState =
  | 'absent'
  | 'current'
  | 'update-available'
  | 'modified'
  | 'conflict'
  | 'incomplete'
  | 'recovery-needed'
  | 'unsupported'
  | 'incompatible';

export interface DevSkillsOperationReadiness {
  readonly state: 'ready' | 'blocked' | 'unchecked';
  readonly reasons: readonly DevSkillsIssue[];
}

export interface DevSkillsReadiness {
  readonly planning: DevSkillsOperationReadiness;
  readonly publication: DevSkillsOperationReadiness;
  readonly watch: DevSkillsOperationReadiness;
}

export interface DevSkillMember {
  readonly id: string;
  readonly role: 'primary' | 'support';
  readonly files: readonly string[];
}
export interface NativeWorkflowRequirements {
  readonly executorVersion: number;
  readonly authoringVersion: number;
  readonly cycleVersion: number;
  readonly watchVersion: number;
  readonly closeoutVersion: number;
}
export interface DevSkillsManifest {
  readonly schemaVersion: 1 | 2;
  readonly nativeRequirements?: NativeWorkflowRequirements;
  readonly workflowProtocol: 1;
  readonly stateSchema: 1;
  readonly minimumRuntime: string;
  readonly releaseVersion: string;
  readonly prerequisites: {
    readonly commands: readonly string[];
    readonly prCommands: readonly string[];
  };
  readonly skills: readonly DevSkillMember[];
  readonly hashes: Readonly<Record<string, string>>;
  readonly digest: string;
}
export interface DevSkillsBundle {
  readonly manifest: DevSkillsManifest;
  readonly files: Readonly<Record<string, string>>;
}
export interface DevSkillsConsumer {
  readonly home: string;
  readonly installationRoot: string;
  readonly target: DevSkillsTarget;
}
export interface DevSkillsPlan {
  readonly schemaVersion: 1;
  readonly action: DevSkillsAction;
  readonly target: DevSkillsTarget;
  readonly consumerId: string;
  readonly installationState: DevSkillsInstallationState;
  readonly bundleDigest: string;
  readonly previewDigest: string;
  readonly changes: readonly {
    readonly path: string;
    readonly beforeHash: string | null;
    readonly afterHash: string | null;
  }[];
  readonly consumers: readonly DevSkillsConsumer[];
  readonly issues: readonly DevSkillsIssue[];
  readonly canApply: boolean;
  readonly readiness?: DevSkillsReadiness;
}
export interface DevSkillsResult extends DevSkillsPlan {
  readonly applied: boolean;
  readonly recovered: boolean;
  readonly retainedPaths: readonly string[];
}
export interface DevSkillsStatus extends DevSkillsEnrollmentStatus {
  readonly target: DevSkillsTarget;
  readonly consumerId: string;
  readonly installationState: DevSkillsInstallationState;
  readonly enrolled: boolean;
  readonly installedDigest?: string;
  readonly issues: readonly DevSkillsIssue[];
  readonly consumers: readonly DevSkillsConsumer[];
  readonly readiness?: DevSkillsReadiness;
}

export interface DevSkillsInstalled {
  readonly manifestSchema?: 1 | 2;
  readonly nativeRequirements?: NativeWorkflowRequirements;
  readonly releaseVersion: string;
  readonly digest: string;
  readonly workflowProtocol: number;
  readonly stateSchema: number;
  readonly minimumRuntime: string;
}
export interface DevSkillsRefreshOutcome {
  readonly intentId: string;
  readonly requestedReleaseVersion: string;
  readonly requestedBundleDigest: string;
  readonly state: 'current' | 'pending' | 'skipped';
  readonly attemptedAt: string;
  readonly completedAt?: string;
  readonly issues: readonly DevSkillsIssue[];
}
export interface DevSkillsEnrollmentStatus {
  readonly enrollmentState: 'unregistered' | 'enrolled' | 'removed';
  readonly enabled: boolean;
  readonly installed?: DevSkillsInstalled;
  readonly lastRefresh?: DevSkillsRefreshOutcome;
}
export interface DevSkillsRuntimeCapabilities {
  readonly schemaVersion: 1 | 2;
  readonly manifestSchemas?: readonly number[];
  readonly nativeFeatures?: NativeWorkflowRequirements;
  readonly runtimeVersion: string;
  readonly workflowProtocols: readonly number[];
  readonly stateSchemas: readonly number[];
  readonly enrollmentSchemas: readonly number[];
}
export interface DevSkillsReleaseIdentity {
  readonly installationRoot: string;
  readonly releaseRoot: string;
  readonly releaseVersion: string;
  readonly bundleDigest: string;
}
export interface DevSkillsRefreshTarget {
  readonly consumerId: string;
  readonly home: string;
  readonly target: DevSkillsTarget;
  readonly enabled: boolean;
  readonly enrollmentState: 'enrolled' | 'removed';
  readonly installed?: DevSkillsInstalled;
  readonly issues: readonly DevSkillsIssue[];
}
export interface DevSkillsRefreshPlan {
  readonly schemaVersion: 1;
  readonly release: DevSkillsReleaseIdentity;
  readonly targets: readonly DevSkillsRefreshTarget[];
  readonly compatibility: 'compatible' | 'incompatible' | 'unknown';
  readonly issues: readonly DevSkillsIssue[];
  readonly previewDigest: string;
}
export interface DevSkillsRefreshResult {
  readonly schemaVersion: 1;
  readonly issues?: readonly DevSkillsIssue[];
  readonly intentId: string;
  readonly release: DevSkillsReleaseIdentity;
  readonly targets: readonly {
    readonly consumerId: string;
    readonly target: DevSkillsTarget;
    readonly outcome: DevSkillsRefreshOutcome;
  }[];
  readonly repairRequired: boolean;
}
export type DevSkillsEnsureOptions =
  | {
      readonly mode: 'setup';
      readonly choice: 'default' | 'disabled';
      readonly operationId: string;
      readonly lease?: DevSkillsMutationLease;
    }
  | {readonly mode: 'maintenance'; readonly lease?: DevSkillsMutationLease};
export interface DevSkillsEnsureResult {
  readonly state: 'installed' | 'current' | 'disabled' | 'pending' | 'setup-needed';
  readonly createdConsumer: boolean;
  readonly operationId?: string;
  readonly result?: DevSkillsResult;
  readonly issues: readonly DevSkillsIssue[];
}
