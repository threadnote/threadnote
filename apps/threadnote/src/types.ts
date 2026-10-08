export type {
  RuntimeConfig,
  RuntimeIdentitySource,
  RuntimeManifestSource,
  ProjectManifest,
  ProjectGraphManifest,
  WorksetManifest,
  ResolvedWorkset,
  SeedManifest,
} from '@threadnote/workspace/config';
import type {MemoryKind, MemoryStatus} from '@threadnote/memory/types';
export type {MemoryKind, MemoryStatus} from '@threadnote/memory/types';
import type {McpToolset} from './mcp/toolset.js';

export type {AgentClient, ConsolidationAgent} from '@threadnote/integrations/agents';
export type ClaudeMcpScope = 'local' | 'project' | 'user';
export type CommandStatus = 'fail' | 'ok' | 'warn';

export type {CommandResult} from '@threadnote/platform/command';

export type {DoctorCheck} from '@threadnote/protocol/doctor';

export interface SeedCandidate {
  readonly destinationUri: string;
  readonly filePath: string;
  readonly projectName: string;
  readonly relativePath: string;
}

export interface SkillCandidate {
  readonly content: string;
  readonly filePath: string;
  readonly hash: string;
  readonly kind: 'command' | 'skill';
  readonly source: string;
}

export interface MappedCommand {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly executable: string;
}

export interface InstallOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly printNextSteps?: boolean;
  readonly repairInvalidConfigs?: boolean;
  readonly start?: boolean;
  readonly withHooks?: boolean;
}

export interface HooksInstallOptions {
  readonly target?: 'desktop' | 'cloud';
  readonly project?: string;
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  /** @internal Recorded relocatable host root used by repair and uninstall. */
  readonly hostRoot?: string;
  readonly remove?: boolean;
  /** @internal The caller already holds the home-wide setup mutation lock. */
  readonly setupLockHeld?: boolean;
}

export interface HookRunnerOptions {
  readonly dryRun?: boolean;
}

export interface RepairOptions {
  readonly coreOnly?: boolean;
  readonly deep?: boolean;
  readonly dryRun?: boolean;
  readonly mcp?: string;
  readonly postUpdate?: boolean;
  readonly start?: boolean;
}

export interface UninstallOptions {
  readonly dryRun?: boolean;
  readonly eraseMemories?: boolean;
  readonly mcp?: string;
  readonly preserveMemories?: boolean;
}

export interface UpdateOptions {
  readonly allowUntrustedSource?: boolean;
  readonly auto?: 'off' | 'on';
  readonly beta?: boolean;
  readonly check?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly json?: boolean;
  readonly postUpdate?: boolean;
  readonly repair?: boolean;
  readonly source?: string;
  readonly stable?: boolean;
  readonly status?: boolean;
  readonly yes?: boolean;
}

export interface VersionOptions {
  readonly allowUntrustedSource?: boolean;
  readonly source?: string;
}

export interface PostUpdateOptions {
  readonly dryRun?: boolean;
  readonly fromVersion?: string;
  readonly toVersion?: string;
  readonly yes?: boolean;
}

export interface DoctorOptions {
  readonly dryRun?: boolean;
  readonly strict?: boolean;
}

export interface ManageOptions {
  readonly open?: boolean;
  readonly uiPort?: number;
}

export interface StartOptions {
  readonly dryRun?: boolean;
  readonly foreground?: boolean;
  readonly launchd?: boolean;
}

export interface SeedOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly graph?: boolean;
  readonly manifest?: string;
  readonly native?: boolean;
  readonly only?: readonly string[];
}

export interface McpInstallOptions {
  readonly apply?: boolean;
  readonly composerClientId?: string;
  readonly composerOAuthScopes?: readonly string[];
  readonly composerCallbackUrl?: string;
  readonly composerCallbackPort?: number;
  readonly composerUrl?: string;
  /** @internal Recorded Claude project/local installation directory used by repair. */
  readonly cwd?: string;
  readonly dryRunApplyCommand?: string;
  /** @internal Recorded relocatable host root used by repair and uninstall. */
  readonly hostRoot?: string;
  readonly name?: string;
  readonly project?: string;
  readonly scope?: ClaudeMcpScope;
  readonly shareId?: string;
  /** @internal The caller already holds the home-wide setup mutation lock. */
  readonly setupLockHeld?: boolean;
  readonly toolset?: McpToolset;
}

export interface RememberOptions {
  /** Graph-indexed repository-relative paths or stable code-graph refs captured as immutable code citations. */
  readonly codeRefs?: readonly string[];
  /** Drop keywords preserved from the replaced memory. Mutually exclusive with keywords and regenerateKeywords. */
  readonly clearKeywords?: boolean;
  /** Explicit compatibility alias for the default private store-now/anchor-later policy. */
  readonly deferCodeRefs?: boolean;
  readonly dryRun?: boolean;
  readonly kind?: MemoryKind;
  /** Explicit search keywords. Skips automatic enrichment. Mutually exclusive with clearKeywords and regenerateKeywords. */
  readonly keywords?: readonly string[];
  readonly project?: string;
  /** Discard preserved keywords and regenerate them. Personal memories only. Mutually exclusive with keywords and clearKeywords. */
  readonly regenerateKeywords?: boolean;
  /** Fail before writing unless every code reference resolves against an exact-current graph. */
  readonly requireCurrentCodeRefs?: boolean;
  /** Repeatable `<type>=<threadnote://memory>` relation declarations. */
  readonly relations?: readonly string[];
  readonly replace?: string;
  readonly sourceAgentClient?: string;
  readonly status?: MemoryStatus;
  readonly stdin?: boolean;
  readonly text?: string;
  readonly topic?: string;
}

export interface CompactOptions {
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly kind?: Extract<MemoryKind, 'durable' | 'handoff' | 'incident'>;
  readonly project?: string;
  readonly topic?: string;
}

export interface MigrateMemoriesOptions {
  readonly allAccounts?: boolean;
  readonly dryRun?: boolean;
  readonly limit?: string;
  readonly sourceAccount?: readonly string[];
}

export interface MigrateLifecycleOptions {
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly limit?: string;
}

export interface MigrateProjectNamesOptions {
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly limit?: string;
}

export interface EnrichMemoriesOptions {
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly installLocalAi?: boolean;
  readonly limit?: string;
}

export interface RecallOptions {
  readonly callerCwd?: string;
  readonly dryRun?: boolean;
  readonly inferScope?: boolean;
  readonly includeArchived?: boolean;
  readonly memoryRefs?: readonly string[];
  readonly nodeLimit?: string;
  readonly project?: string;
  readonly query?: string;
  readonly relationTypes?: readonly string[];
  readonly threshold?: string;
  readonly uri?: string;
  readonly workset?: string;
}

export interface ReadOptions {
  readonly dryRun?: boolean;
}

export interface ListOptions {
  readonly all?: boolean;
  readonly dryRun?: boolean;
  readonly nodeLimit?: string;
  readonly recursive?: boolean;
  readonly simple?: boolean;
}

export interface HandoffOptions {
  readonly blockers?: string;
  readonly ci?: string;
  /** Drop keywords preserved from the replaced memory. Mutually exclusive with explicit keywords. */
  readonly clearKeywords?: boolean;
  /** Graph-indexed repository-relative paths or stable code-graph refs captured as immutable code citations. */
  readonly codeRefs?: readonly string[];
  /** Explicit compatibility alias for the default private store-now/anchor-later policy. */
  readonly deferCodeRefs?: boolean;
  readonly dryRun?: boolean;
  readonly issue?: string;
  /** Explicit search keywords. Handoffs preserve prior keywords by default and never generate keywords. */
  readonly keywords?: readonly string[];
  readonly nextStep?: string;
  readonly pr?: string;
  readonly project?: string;
  readonly references?: readonly string[];
  readonly replace?: string;
  /** Fail before writing unless every code reference resolves against an exact-current graph. */
  readonly requireCurrentCodeRefs?: boolean;
  readonly sessionId?: string;
  readonly sourceAgentClient?: string;
  readonly task?: string;
  readonly tests?: string;
  readonly timestamped?: boolean;
  readonly topic?: string;
  readonly trace?: string;
}

export interface ArchiveOptions {
  /** Internal composite-mutation option; the caller must refresh recall indexes from the final state. */
  readonly deferRecallIndexRefresh?: boolean;
  /** Internal accumulator for the archive URI created by a composite mutation. */
  readonly invalidatedUris?: string[];
  readonly dryRun?: boolean;
  /** Internal optimistic-concurrency guard used by hygiene apply. */
  readonly expectedContent?: string;
  readonly kind?: MemoryKind;
  readonly project?: string;
  readonly topic?: string;
}

export interface PackOptions {
  readonly dryRun?: boolean;
  readonly path?: string;
  readonly targetUri?: string;
  readonly uri?: string;
}

export interface ForgetOptions {
  readonly dryRun?: boolean;
}

export interface InitManifestOptions {
  readonly dryRun?: boolean;
  readonly path?: string;
  readonly replace?: boolean;
  readonly repo?: readonly string[];
  /** @internal The caller already holds the home-wide setup mutation lock. */
  readonly setupLockHeld?: boolean;
}

export interface JsonObject {
  readonly [key: string]: unknown;
}

export interface ShareRuntime {
  readonly account: string;
  readonly agentContextHome: string;
  readonly agentId: string;
  readonly user: string;
}

export interface ShareTeamConfig {
  readonly access?: ShareTeamAccess;
  readonly addedAt: string;
  readonly gitdir: string;
  readonly name: string;
  readonly remote: string;
  readonly worktree: string;
}

export type ShareTeamAccess = 'read-only' | 'read-write';

export interface ShareTeamsFile {
  readonly defaultTeam?: string;
  readonly teams: Readonly<Record<string, ShareTeamConfig>>;
  readonly version: number;
}

export interface ShareInitOptions {
  readonly dryRun?: boolean;
  readonly push?: boolean;
  readonly readOnly?: boolean;
  readonly setDefault?: boolean;
  readonly team?: string;
}

export interface ShareStatusOptions {
  readonly dryRun?: boolean;
  readonly team?: string;
}

export interface ShareSyncOptions {
  readonly autoCommit?: boolean;
  readonly dryRun?: boolean;
  readonly message?: string;
  readonly push?: boolean;
  readonly team?: string;
}

export interface ShareConflictOptions {
  readonly team?: string;
}

export interface ShareConflictShowOptions {
  readonly team?: string;
}

export type ShareConflictTake = 'local' | 'shared';

export interface ShareConflictResolveOptions {
  /** Refuse to resolve if any inspected version changed since review. */
  readonly expectedRevision?: string;
  readonly dryRun?: boolean;
  readonly fromFile?: string;
  readonly mergedContent?: string;
  readonly message?: string;
  readonly push?: boolean;
  readonly take?: ShareConflictTake;
  readonly team?: string;
}

export interface SharePublishOptions {
  /** Explicitly publish without pending code citations and discard the private pending intent. */
  readonly allowUncitedPendingCodeRefs?: boolean;
  readonly dryRun?: boolean;
  readonly message?: string;
  readonly preview?: boolean;
  readonly push?: boolean;
  readonly redact?: boolean;
  readonly team?: string;
}

export interface FinalizeCodeRefsOptions {
  readonly limit?: string;
  readonly uris?: readonly string[];
}

export type ShareAgentArtifactAgent = 'claude' | 'codex' | 'cursor';
export type ShareAgentArtifactKind = 'command' | 'pack' | 'skill';

export interface SharePublishArtifactOptions {
  readonly agent?: ShareAgentArtifactAgent;
  readonly allowBinary?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly kind?: ShareAgentArtifactKind;
  readonly message?: string;
  readonly name?: string;
  readonly preview?: boolean;
  readonly push?: boolean;
  readonly redact?: boolean;
  readonly team?: string;
}

export interface ShareInstallArtifactsOptions {
  readonly agent?: ShareAgentArtifactAgent;
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly kind?: ShareAgentArtifactKind;
  readonly name?: string;
  readonly sync?: boolean;
  readonly team?: string;
}

export interface ShareListArtifactsOptions {
  readonly agent?: ShareAgentArtifactAgent;
  readonly kind?: ShareAgentArtifactKind;
  readonly name?: string;
  readonly sync?: boolean;
  readonly team?: string;
}

export interface ShareUnpublishOptions {
  readonly dryRun?: boolean;
  readonly message?: string;
  readonly push?: boolean;
  readonly team?: string;
}

export interface ShareListOptions {
  readonly dryRun?: boolean;
}

export interface ShareRenameOptions {
  readonly dryRun?: boolean;
  readonly team?: string;
  readonly to?: string;
}

export interface ShareSetUrlOptions {
  readonly dryRun?: boolean;
  readonly team?: string;
}

export interface ShareSetAccessOptions {
  readonly dryRun?: boolean;
  readonly mode?: ShareTeamAccess;
  readonly team?: string;
}

export interface ShareRemoveOptions {
  readonly dryRun?: boolean;
  readonly keepFiles?: boolean;
  readonly preserveLocal?: boolean;
  readonly team?: string;
}
