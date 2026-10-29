import {Effect, Schema} from 'effect';
import {type CodeGraphBuildOwnerIdentity} from '../build/owner.js';
import {type CodeGraphEdge, type CodeGraphSnapshot} from '../types.js';
import {
  type CodeGraphWorkspaceBuildSystem,
  type CodeGraphWorkspaceComponentKind,
  type CodeGraphWorkspaceProvenance,
} from '../languages/types.js';

type CodeGraphTraversalEdge = Pick<
  CodeGraphEdge,
  'id' | 'sourceId' | 'targetId' | 'relation' | 'provenance' | 'confidence'
>;

interface SnapshotRow {
  readonly scope_id?: string;
  readonly base_snapshot_id: unknown;
  readonly commit_id: string;
  readonly completed_at: unknown;
  readonly dirty: number;
  readonly edge_count: number;
  readonly extractor_set: string;
  readonly file_count: number;
  readonly graph_content_id: unknown;
  readonly id: string;
  readonly overlay_fingerprint: unknown;
  readonly repository_id: string;
  readonly state: CodeGraphSnapshot['state'];
  readonly symbol_count: number;
  readonly worktree_id: string;
}

interface SymbolRow {
  readonly arity: unknown;
  readonly content_hash: string;
  readonly documentation: unknown;
  readonly exported: number;
  readonly id: string;
  readonly kind: string;
  readonly language: string;
  readonly name: string;
  readonly lookup_keys_json: string;
  readonly package_name: unknown;
  readonly path: string;
  readonly qualified_name: string;
  readonly resolution_domain: unknown;
  readonly resolution_scope_id: unknown;
  readonly signature: unknown;
  readonly span_json: string;
}

interface EdgeRow {
  readonly confidence: number;
  readonly evidence_path: string;
  readonly evidence_span_json: string;
  readonly id: string;
  readonly provenance: CodeGraphEdge['provenance'];
  readonly relation: CodeGraphEdge['relation'];
  readonly source_id: unknown;
  readonly source_name: string;
  readonly target_id: unknown;
  readonly target_name: string;
}

interface FileBlobRow {
  readonly blob_id: unknown;
  readonly content_hash: string;
  readonly facts_json: string;
  readonly reuse_class: unknown;
}

interface CodeGraphActivationLease {
  readonly durationMilliseconds: number;
  readonly token: string;
}

interface PersistentBuildOwnerCandidate extends CodeGraphBuildOwnerIdentity {
  readonly evidenceValid: boolean;
  readonly logicalSnapshotId: string;
  readonly ownerToken: string;
  readonly snapshotId: string;
  readonly worktreeId: string;
}

interface DeferredVisualizationComponentRow {
  readonly build_system: CodeGraphWorkspaceBuildSystem;
  readonly id: string;
  readonly kind: CodeGraphWorkspaceComponentKind;
  readonly name: string;
  readonly provenance: CodeGraphWorkspaceProvenance;
  readonly workspace_id: string;
}

class CodeGraphPromotionCapacityPlanChanged extends Schema.TaggedError<
  CodeGraphPromotionCapacityPlanChanged,
  {readonly brand: unique symbol}
>()('CodeGraphPromotionCapacityPlanChanged', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String.pipe(
    Schema.withConstructorDefault(
      Effect.succeed('Code graph promotion capacity plan changed during the write; retry the operation.'),
    ),
  ),
}) {}

class CodeGraphCacheCapacityPlanChanged extends Schema.TaggedError<
  CodeGraphCacheCapacityPlanChanged,
  {readonly brand: unique symbol}
>()('CodeGraphCacheCapacityPlanChanged', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String.pipe(
    Schema.withConstructorDefault(
      Effect.succeed('Code graph cache capacity plan changed during the write; retry the operation.'),
    ),
  ),
}) {}

export {
  CodeGraphTraversalEdge,
  SnapshotRow,
  SymbolRow,
  EdgeRow,
  CodeGraphActivationLease,
  PersistentBuildOwnerCandidate,
  CodeGraphCacheCapacityPlanChanged,
  FileBlobRow,
  DeferredVisualizationComponentRow,
  CodeGraphPromotionCapacityPlanChanged,
};
