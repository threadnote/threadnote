import type {ManagerMemoryKind, ManagerMemoryStatus} from './ui/contracts.js';

export interface ObsidianSource {
  readonly id: string;
  readonly vault: string;
  readonly enabled: boolean;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly inbox?: string;
  readonly watch: boolean;
}
export interface ObsidianProjection {
  readonly id: string;
  readonly vault: string;
  readonly enabled: boolean;
  readonly folder: string;
  readonly kinds: readonly ManagerMemoryKind[];
  readonly statuses: readonly ManagerMemoryStatus[];
  readonly includeShared: boolean;
  readonly selectedUris?: readonly string[];
}
export interface ObsidianIntegration {
  readonly sources: readonly ObsidianSource[];
  readonly projections: readonly ObsidianProjection[];
}
export type ObsidianAction =
  | 'save-source'
  | 'save-projection'
  | 'sync-source'
  | 'sync-projection'
  | 'remove-source'
  | 'remove-projection'
  | 'scan-inbox'
  | 'set-enabled';
export interface IntegrationResult {
  readonly output: string;
  readonly entries: readonly {readonly action: string; readonly relativePath: string; readonly detail?: string}[];
  readonly reviewCount?: number;
  readonly applied: boolean;
  readonly warnings?: readonly string[];
}

export type IntegrationProductId = 'obsidian' | 'superhuman' | 'pocket';

export interface PocketSource {
  readonly id: string;
  readonly enabled: boolean;
  readonly project: string | null;
  readonly credentialEnv: string;
  readonly credentialStorage?: 'local';
  readonly credentialConfigured: boolean;
  readonly refreshIntervalMinutes: number;
  readonly maxStaleHours: number;
  readonly status: 'active' | 'needs-sync' | 'needs-attention';
  readonly recordings: number;
  readonly chunks: number;
  readonly lastSyncedAt?: number;
  readonly nextAttemptAt?: number;
  readonly progress?: {readonly page: number; readonly offset: number};
}

export interface SuperhumanDocumentSelection {
  readonly id: string;
  readonly pages?: readonly string[];
}

export interface SuperhumanSource {
  readonly id: string;
  readonly enabled: boolean;
  readonly project: string | null;
  readonly documents: readonly SuperhumanDocumentSelection[];
  readonly credentialEnv: string;
  readonly credentialStorage?: 'local';
  readonly credentialConfigured: boolean;
  readonly includeHidden: boolean;
  readonly refreshIntervalMinutes: number;
  readonly maxStaleHours: number;
  readonly status: 'active' | 'needs-sync' | 'needs-attention';
  readonly chunks: number;
  readonly lastSyncedAt?: number;
  readonly nextAttemptAt?: number;
}

export interface ManagerIntegrations {
  readonly obsidian: ObsidianIntegration;
  readonly superhuman: {readonly sources: readonly SuperhumanSource[]};
  readonly pocket: {readonly sources: readonly PocketSource[]};
}

export type SuperhumanAction = 'save-source' | 'sync-source' | 'remove-source' | 'set-enabled' | 'resolve-links';

export interface ResolvedSuperhumanSelection {
  readonly documents: readonly SuperhumanDocumentSelection[];
  readonly selections: readonly {
    readonly documentId: string;
    readonly pageId?: string;
    readonly name: string;
  }[];
}
