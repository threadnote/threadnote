import type {MemoryKind, MemoryStatus} from '@threadnote/memory/types';
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
  readonly kinds: readonly MemoryKind[];
  readonly statuses: readonly MemoryStatus[];
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
