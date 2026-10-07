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
}
