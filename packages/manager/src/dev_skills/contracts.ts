/** Browser wire contracts. Application lifecycle implementation remains application-owned. */
export type ManagerDevSkillsScope = 'user' | 'project' | 'local';
export type ManagerDevSkillsProfile = 'desktop' | 'codex-cloud-personal' | 'cursor-cloud-personal';
export type ManagerDevSkillsAction = 'install' | 'update' | 'remove';

export interface ManagerDevSkillsSelector {
  readonly agent: string;
  readonly scope?: ManagerDevSkillsScope;
  readonly cwd?: string;
  readonly profile?: ManagerDevSkillsProfile;
}

/** Catalog-derived locations. A public request never supplies its own destination. */
export interface ManagerDevSkillsTarget {
  readonly surfaceId: string;
  readonly agentId: string;
  readonly profile: ManagerDevSkillsProfile;
  readonly scope: ManagerDevSkillsScope;
  readonly cwd?: string;
  readonly skillRoot: string;
  readonly layout: 'directory' | 'flat';
  readonly discoveryRoots: readonly string[];
}

export interface ManagerDevSkillsIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export type ManagerDevSkillsInstallationState =
  | 'absent'
  | 'current'
  | 'update-available'
  | 'modified'
  | 'conflict'
  | 'incomplete'
  | 'recovery-needed'
  | 'unsupported'
  | 'incompatible';

export interface ManagerDevSkillsOperationReadiness {
  readonly state: 'ready' | 'blocked' | 'unchecked';
  readonly reasons: readonly ManagerDevSkillsIssue[];
}

export interface ManagerDevSkillsReadiness {
  readonly planning: ManagerDevSkillsOperationReadiness;
  readonly publication: ManagerDevSkillsOperationReadiness;
  readonly watch: ManagerDevSkillsOperationReadiness;
}

export interface ManagerDevSkillMember {
  readonly id: string;
  readonly role: 'primary' | 'support';
  readonly files: readonly string[];
}
export interface ManagerDevSkillsManifest {
  readonly schemaVersion: 1;
  readonly workflowProtocol: 1;
  readonly stateSchema: 1;
  readonly minimumRuntime: string;
  readonly releaseVersion: string;
  readonly prerequisites: {
    readonly python: string;
    readonly commands: readonly string[];
    readonly prCommands: readonly string[];
  };
  readonly skills: readonly ManagerDevSkillMember[];
  readonly hashes: Readonly<Record<string, string>>;
  readonly digest: string;
}
export interface ManagerDevSkillsBundle {
  readonly manifest: ManagerDevSkillsManifest;
  readonly files: Readonly<Record<string, string>>;
}
export interface ManagerDevSkillsConsumer {
  readonly home: string;
  readonly installationRoot: string;
  readonly target: ManagerDevSkillsTarget;
}
export interface ManagerDevSkillsPlan {
  readonly schemaVersion: 1;
  readonly action: ManagerDevSkillsAction;
  readonly target: ManagerDevSkillsTarget;
  readonly consumerId: string;
  readonly installationState: ManagerDevSkillsInstallationState;
  readonly bundleDigest: string;
  readonly previewDigest: string;
  readonly changes: readonly {
    readonly path: string;
    readonly beforeHash: string | null;
    readonly afterHash: string | null;
  }[];
  readonly consumers: readonly ManagerDevSkillsConsumer[];
  readonly issues: readonly ManagerDevSkillsIssue[];
  readonly canApply: boolean;
  readonly readiness?: ManagerDevSkillsReadiness;
}
export interface ManagerDevSkillsResult extends ManagerDevSkillsPlan {
  readonly applied: boolean;
  readonly recovered: boolean;
  readonly retainedPaths: readonly string[];
}
export interface ManagerDevSkillsTargetStatus extends ManagerDevSkillsEnrollmentStatus {
  readonly target: ManagerDevSkillsTarget;
  readonly consumerId: string;
  readonly installationState: ManagerDevSkillsInstallationState;
  readonly enrolled: boolean;
  readonly installedDigest?: string;
  readonly issues: readonly ManagerDevSkillsIssue[];
  readonly consumers: readonly ManagerDevSkillsConsumer[];
  readonly readiness?: ManagerDevSkillsReadiness;
}

export interface ManagerDevSkillsInstalled {
  readonly releaseVersion: string;
  readonly digest: string;
  readonly workflowProtocol: number;
  readonly stateSchema: number;
  readonly minimumRuntime: string;
}
export interface ManagerDevSkillsRefreshOutcome {
  readonly intentId: string;
  readonly requestedReleaseVersion: string;
  readonly requestedBundleDigest: string;
  readonly state: 'current' | 'pending' | 'skipped';
  readonly attemptedAt: string;
  readonly completedAt?: string;
  readonly issues: readonly ManagerDevSkillsIssue[];
}
export interface ManagerDevSkillsEnrollmentStatus {
  readonly enrollmentState: 'unregistered' | 'enrolled' | 'removed';
  readonly enabled: boolean;
  readonly installed?: ManagerDevSkillsInstalled;
  readonly lastRefresh?: ManagerDevSkillsRefreshOutcome;
}
export type ManagerDevSkillsSurface = {
  readonly surfaceId: string;
  readonly agentId: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
} & (
  | {
      readonly status: 'managed';
      readonly profile: ManagerDevSkillsProfile;
      readonly scopes: readonly ManagerDevSkillsScope[];
      readonly scopeReason?: string;
      readonly defaultScope: ManagerDevSkillsScope;
      readonly platforms: readonly string[];
      readonly layout: 'directory' | 'flat';
    }
  | {readonly status: 'unsupported'; readonly reason: string}
);
export interface ManagerDevSkillsCatalog {
  readonly schemaVersion: 1;
  readonly platform: string;
  readonly bundle: ManagerDevSkillsManifest;
  readonly surfaces: readonly ManagerDevSkillsSurface[];
}
/** Lossless, normalized registered identities; never display-sanitized destinations. */
export interface ManagerDevSkillsProjects {
  readonly schemaVersion: 1;
  readonly projects: readonly {readonly name: string; readonly path: string}[];
}
export interface ManagerDevSkillsStatus {
  readonly schemaVersion: 1;
  readonly bundle: ManagerDevSkillsManifest;
  readonly targets: readonly ManagerDevSkillsTargetStatus[];
}
export interface ManagerDevSkillsPreviewRequest {
  readonly action: ManagerDevSkillsAction;
  readonly selector: ManagerDevSkillsSelector;
}
export interface ManagerDevSkillsApplyRequest extends ManagerDevSkillsPreviewRequest {
  readonly previewDigest: string;
  readonly confirm: true;
}
export interface ManagerDevSkillsApplyResponse {
  readonly result: ManagerDevSkillsResult;
  readonly status: ManagerDevSkillsStatus;
}
export interface ManagerDevSkillsApiError {
  readonly code: string;
  readonly error: string;
  readonly recovery: 'preview' | 'select-project' | 'select-target' | 'retry';
  readonly retryAfterMilliseconds: number;
}
export const MANAGER_DEV_SKILLS_ROUTES = {
  catalog: '/api/dev-skills/catalog',
  projects: '/api/dev-skills/projects',
  status: '/api/dev-skills/status',
  preview: '/api/dev-skills/preview',
  apply: '/api/dev-skills/apply',
} as const;
