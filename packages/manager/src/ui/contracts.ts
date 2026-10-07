export type PanelName =
  | 'context'
  | 'context-health'
  | 'doctor'
  | 'graph'
  | 'home'
  | 'integrations'
  | 'memory'
  | 'processes'
  | 'reviews'
  | 'shares'
  | 'worksets';
export type SelectId = 'agent' | 'kind' | 'status';
export type ManagerMemoryKind = 'durable' | 'handoff' | 'incident' | 'preference' | 'smoke';
export type ManagerMemoryStatus = 'active' | 'archived' | 'expired' | 'superseded';

export interface MemoryMetadata {
  readonly archivedFrom?: string;
  readonly kind: ManagerMemoryKind;
  readonly project?: string;
  readonly sourceAgentClient: string;
  readonly status: ManagerMemoryStatus;
  readonly supersedes?: string;
  readonly timestamp: string;
  readonly topic?: string;
}

export interface TreeNode {
  readonly children?: readonly TreeNode[];
  readonly isDir: boolean;
  readonly isShared: boolean;
  readonly isSystem: boolean;
  readonly metadata?: MemoryMetadata;
  readonly modTime?: string;
  readonly name: string;
  readonly relativePath: string;
  readonly sharedTeam?: string;
  readonly size?: number;
  readonly uri: string;
}

export interface ShareSummary {
  readonly addedAt: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly default: boolean;
  readonly dirty?: boolean;
  readonly gitdir: string;
  readonly name: string;
  readonly remote: string;
  readonly status?: string;
  readonly warning?: string;
  readonly worktree: string;
}

export interface BulkItemResult {
  readonly error?: string;
  readonly ok: boolean;
  readonly output?: string;
  readonly uri: string;
}

export interface TargetForm {
  kind: ManagerMemoryKind;
  project: string;
  status: ManagerMemoryStatus;
  team: string;
  topic: string;
}
