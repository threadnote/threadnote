import {Predicate} from 'effect';
import type {
  TopicDependencyExpansionInput,
  TopicDependencyExpansionOperation,
  TopicDependencyExpansionOmission,
} from '@threadnote/memory/topic-maintenance-expansion';
import * as EffectRecord from 'effect/Record';

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
  if (!Predicate.isObject(value)) return false;
  return (
    EffectRecord.keys(value).length === 5 &&
    value.action === 'restart' &&
    typeof value.targetUri === 'string' &&
    typeof value.project === 'string' &&
    typeof value.revision === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.revision) &&
    typeof value.approvalDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.approvalDigest)
  );
}
