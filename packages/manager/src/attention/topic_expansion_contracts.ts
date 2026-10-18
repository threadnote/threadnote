import type {
  TopicDependencyExpansionInput,
  TopicDependencyExpansionOperation,
  TopicDependencyExpansionOmission,
} from '@threadnote/memory/topic-maintenance-expansion';

/** Checkout paths and internal graph proof stay on the server. */
export type ManagerTopicExpansionSelection = Omit<TopicDependencyExpansionInput, 'root' | 'project'>;
export interface ManagerTopicExpansionInspection {
  readonly status: 'ready';
  readonly sourceKind: 'code';
  readonly targetUri: string;
  readonly project: string;
  readonly configDigest: string;
  readonly body: string;
  readonly warning: string;
  readonly currentScope: readonly {
    readonly kind: 'configuration' | 'dependency';
    readonly citationId: string;
    readonly path?: string;
  }[];
  readonly seeds: readonly {
    readonly id: string;
    readonly label: string;
    readonly path: string;
    readonly kind: string;
    readonly citationId: string;
  }[];
  readonly choices?: {
    readonly eligible: readonly {readonly id: string; readonly path: string; readonly contentHash: string}[];
    readonly omissions: readonly TopicDependencyExpansionOmission[];
  };
  readonly coverage?: readonly {
    readonly seedId: string;
    readonly status: 'exhaustive';
    readonly visitedNodes: number;
    readonly inspectedEdges: number;
  }[];
}
export interface ManagerTopicExpansionPreview {
  readonly status: 'preview';
  readonly operation?: TopicDependencyExpansionOperation;
  readonly targetUri: string;
  readonly project: string;
  readonly selection: ManagerTopicExpansionSelection;
  readonly revision: string;
  readonly approvalDigest: string;
  readonly content: string;
  readonly body: string;
  readonly additions: readonly {
    readonly kind: 'configuration' | 'dependency';
    readonly ref: string;
    readonly path: string;
    readonly citationId: string;
  }[];
  readonly omissions: readonly TopicDependencyExpansionOmission[];
  readonly metadataDiff: readonly {readonly field: string; readonly beforeHash: string; readonly afterHash: string}[];
  readonly coverage: readonly {
    readonly seedId: string;
    readonly status: 'exhaustive';
    readonly visitedNodes: number;
    readonly inspectedEdges: number;
  }[];
}
export interface ManagerTopicExpansionApplied {
  readonly status: 'expanded' | 'already-expanded';
  readonly targetUri: string;
  readonly reviewId: string;
  readonly revision: string;
}

/** Minimal exact identity for an explicitly requested fresh review; contains no old proposal. */
export interface ManagerTopicExpansionRecovery {
  readonly action: 'restart';
  readonly targetUri: string;
  readonly project: string;
  readonly revision: string;
  readonly approvalDigest: string;
}
export function isManagerTopicExpansionRecovery(value: unknown): value is ManagerTopicExpansionRecovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return (
    Object.keys(fields).length === 5 &&
    fields.action === 'restart' &&
    typeof fields.targetUri === 'string' &&
    typeof fields.project === 'string' &&
    typeof fields.revision === 'string' &&
    /^[a-f0-9]{64}$/u.test(fields.revision) &&
    typeof fields.approvalDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(fields.approvalDigest)
  );
}
