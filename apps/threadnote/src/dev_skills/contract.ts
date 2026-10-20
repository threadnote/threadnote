import {Schema} from 'effect';

export class DevSkillsError extends Schema.TaggedError<DevSkillsError>()('DevSkillsError', {
  code: Schema.String,
  message: Schema.String,
}) {}

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
export interface DevSkillsManifest {
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
export interface DevSkillsStatus {
  readonly target: DevSkillsTarget;
  readonly consumerId: string;
  readonly installationState: DevSkillsInstallationState;
  readonly enrolled: boolean;
  readonly installedDigest?: string;
  readonly issues: readonly DevSkillsIssue[];
  readonly consumers: readonly DevSkillsConsumer[];
  readonly readiness?: DevSkillsReadiness;
}
