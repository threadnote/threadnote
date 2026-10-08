import type {ConsolidationProvenance, ConsolidationSource} from '@threadnote/memory/consolidation';

export interface ConsolidationModelOption {
  readonly id: string;
  readonly label: string;
  readonly isDefault: boolean;
}

export interface ConsolidationModelsResponse {
  readonly models: readonly ConsolidationModelOption[];
}

export interface ConsolidationJobResponse {
  readonly sources?: readonly ConsolidationSource[];
  readonly agent: string;
  readonly model?: string;
  readonly draft?: string;
  readonly error?: string;
  readonly id: string;
  readonly sourceUris: readonly string[];
  readonly status: 'completed' | 'failed' | 'running';
}

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
  readonly consolidation?: ConsolidationProvenance;
  readonly consolidationError?: string;
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

export interface MemoryResponse {
  readonly content: string;
  readonly node: TreeNode;
  readonly record?: {
    readonly body: string;
    readonly content: string;
    readonly metadata: MemoryMetadata;
    readonly uri: string;
  };
}
export interface ReadResponse {
  readonly content: string;
  readonly localMemory?: MemoryResponse;
  readonly output: string;
}

export interface TreeResponse {
  readonly resourcesTree: TreeNode;
  readonly tree: TreeNode;
}

export interface DoctorCheck {
  readonly detail: string;
  readonly name: string;
  readonly status: 'fail' | 'ok' | 'warn';
}
