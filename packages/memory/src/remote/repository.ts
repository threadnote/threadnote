import {Schema, type Effect} from 'effect';
import type {RemoteMemoryUriAliasV1} from './address.js';
import type {RemoteLifecycleInputV1, RemoteMemoryKind} from './contracts.js';
import type {RemoteHandoffLifecycleOperation, RemoteHandoffLifecycleState} from './lifecycle.js';
import type {RemoteMemoryActorV1, RemoteMemoryReceiptV1} from './receipts.js';
import type {RemoteMemoryHeadStatus, RemoteMutationConflictReason, RemoteMutationIntentV1} from './revisions.js';

export const REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION = 1 as const;
export const REMOTE_MEMORY_REPOSITORY_ERROR_CODES = [
  'cancelled',
  'invalid_request',
  'not_found',
  'storage_unavailable',
  'transaction_failed',
] as const;

export type RemoteMemoryRepositoryErrorCode = (typeof REMOTE_MEMORY_REPOSITORY_ERROR_CODES)[number];

export class RemoteMemoryRepositoryError extends Schema.TaggedError<
  RemoteMemoryRepositoryError,
  {readonly brand: unique symbol}
>()('RemoteMemoryRepositoryError', {
  code: Schema.Literals(REMOTE_MEMORY_REPOSITORY_ERROR_CODES),
  message: Schema.String,
  requestId: Schema.String,
  retryable: Schema.Boolean,
}) {}

/** Authorization must resolve this scope before the repository is called. */
export interface RemoteMemoryRepositoryScopeV1 {
  readonly policyVersion: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly shareId: string;
  readonly tenantId: string;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export interface RemoteStoredMemoryV1 {
  readonly actor?: RemoteMemoryActorV1;
  readonly baseRevision?: string;
  readonly canonicalContent: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly kind: RemoteMemoryKind;
  readonly lifecycle?: RemoteLifecycleInputV1;
  readonly logicalKey: string;
  readonly operationId: string;
  readonly project: string;
  readonly revision: string;
  readonly shareGeneration: number;
  readonly status: RemoteMemoryHeadStatus;
  readonly topic: string;
  readonly uri: string;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export interface RemoteMemoryRepositoryReadRequestV1 {
  readonly revision?: string;
  readonly scope: RemoteMemoryRepositoryScopeV1;
  readonly uri: string;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export type RemoteMemoryRepositoryReadResultV1 =
  | {
      readonly found: false;
      readonly receipt: RemoteMemoryReceiptV1;
      readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
    }
  | {
      readonly found: true;
      readonly memory: RemoteStoredMemoryV1;
      readonly receipt: RemoteMemoryReceiptV1;
      readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
    };

export interface RemoteMemoryRepositoryListRequestV1 {
  readonly cursor?: string;
  readonly kinds?: readonly RemoteMemoryKind[];
  readonly limit: number;
  readonly prefixUri?: string;
  readonly project?: string;
  readonly scope: RemoteMemoryRepositoryScopeV1;
  readonly statuses?: readonly RemoteMemoryHeadStatus[];
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export interface RemoteMemoryRepositoryListResultV1 {
  readonly memories: readonly RemoteStoredMemoryV1[];
  readonly nextCursor?: string;
  readonly receipt: RemoteMemoryReceiptV1;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export interface RemoteMemoryRepositoryRecallRequestV1 {
  readonly kinds?: readonly RemoteMemoryKind[];
  readonly limit: number;
  readonly project: string;
  readonly query: string;
  readonly scope: RemoteMemoryRepositoryScopeV1;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export interface RemoteMemoryRecallMatchV1 {
  readonly memory: RemoteStoredMemoryV1;
  readonly reasons: readonly string[];
  readonly score: number;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export interface RemoteMemoryRepositoryRecallResultV1 {
  readonly matches: readonly RemoteMemoryRecallMatchV1[];
  readonly receipt: RemoteMemoryReceiptV1;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export interface RemoteMemoryRepositoryMutationRequestV1 {
  readonly actor?: RemoteMemoryActorV1;
  readonly canonicalContent: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly intent: RemoteMutationIntentV1;
  readonly kind: RemoteMemoryKind;
  readonly lifecycle?: RemoteLifecycleInputV1;
  readonly project: string;
  readonly scope: RemoteMemoryRepositoryScopeV1;
  readonly topic: string;
  readonly uri: string;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export type RemoteMemoryRepositoryMutationOutcomeV1 =
  | {
      readonly kind: 'committed';
      readonly memory: RemoteStoredMemoryV1;
      readonly receipt: RemoteMemoryReceiptV1;
      readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
    }
  | {
      readonly kind: 'conflict';
      readonly currentRevision?: string;
      readonly currentStatus?: RemoteMemoryHeadStatus;
      readonly reason: RemoteMutationConflictReason;
      readonly receipt: RemoteMemoryReceiptV1;
      readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
    }
  | {
      readonly kind: 'idempotency_conflict';
      readonly receipt: RemoteMemoryReceiptV1;
      readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
    }
  | {
      readonly kind: 'replayed';
      readonly receipt: RemoteMemoryReceiptV1;
      readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
    };

export interface RemoteMemoryRepositoryHandoffLifecycleRequestV1 {
  readonly actor?: RemoteMemoryActorV1;
  readonly intent: RemoteMutationIntentV1;
  readonly operation: RemoteHandoffLifecycleOperation;
  readonly scope: RemoteMemoryRepositoryScopeV1;
  readonly uri: string;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export type RemoteMemoryRepositoryHandoffLifecycleOutcomeV1 =
  | RemoteMemoryRepositoryMutationOutcomeV1
  | {
      readonly currentState: RemoteHandoffLifecycleState;
      readonly kind: 'lifecycle_rejected';
      readonly receipt: RemoteMemoryReceiptV1;
      readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
    };

export interface RemoteMemoryRepositoryImportRecordV1 {
  readonly aliases: readonly string[];
  readonly canonicalContent: string;
  readonly contentHash: string;
  readonly kind: RemoteMemoryKind;
  readonly project: string;
  readonly sourceUri: string;
  readonly topic: string;
  readonly uri: string;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export interface RemoteMemoryRepositoryImportRequestV1 {
  readonly actor?: RemoteMemoryActorV1;
  readonly dryRun: boolean;
  readonly operationId: string;
  readonly records: readonly RemoteMemoryRepositoryImportRecordV1[];
  readonly scope: RemoteMemoryRepositoryScopeV1;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export interface RemoteMemoryRepositoryImportItemResultV1 {
  readonly sourceUri: string;
  readonly status: 'blocked' | 'conflict' | 'imported' | 'unchanged' | 'would_import';
  readonly uri?: string;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export interface RemoteMemoryRepositoryImportResultV1 {
  readonly items: readonly RemoteMemoryRepositoryImportItemResultV1[];
  readonly receipt: RemoteMemoryReceiptV1;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export interface RemoteMemoryRepositoryExportRequestV1 {
  readonly cursor?: string;
  readonly kinds?: readonly RemoteMemoryKind[];
  readonly limit: number;
  readonly project?: string;
  readonly scope: RemoteMemoryRepositoryScopeV1;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export interface RemoteMemoryRepositoryExportRecordV1 {
  readonly aliases: readonly RemoteMemoryUriAliasV1[];
  readonly memory: RemoteStoredMemoryV1;
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

export interface RemoteMemoryRepositoryExportResultV1 {
  readonly nextCursor?: string;
  readonly receipt: RemoteMemoryReceiptV1;
  readonly records: readonly RemoteMemoryRepositoryExportRecordV1[];
  readonly version: typeof REMOTE_MEMORY_REPOSITORY_CONTRACT_VERSION;
}

/**
 * Authoritative memory-store port. Implementations must enforce tenant/share
 * predicates independently of caller validation and make mutations atomic.
 */
export interface RemoteMemoryRepository {
  readonly exportRecords: (
    request: RemoteMemoryRepositoryExportRequestV1,
  ) => Effect.Effect<RemoteMemoryRepositoryExportResultV1, RemoteMemoryRepositoryError>;
  readonly importRecords: (
    request: RemoteMemoryRepositoryImportRequestV1,
  ) => Effect.Effect<RemoteMemoryRepositoryImportResultV1, RemoteMemoryRepositoryError>;
  readonly list: (
    request: RemoteMemoryRepositoryListRequestV1,
  ) => Effect.Effect<RemoteMemoryRepositoryListResultV1, RemoteMemoryRepositoryError>;
  readonly mutate: (
    request: RemoteMemoryRepositoryMutationRequestV1,
  ) => Effect.Effect<RemoteMemoryRepositoryMutationOutcomeV1, RemoteMemoryRepositoryError>;
  readonly read: (
    request: RemoteMemoryRepositoryReadRequestV1,
  ) => Effect.Effect<RemoteMemoryRepositoryReadResultV1, RemoteMemoryRepositoryError>;
  readonly recall: (
    request: RemoteMemoryRepositoryRecallRequestV1,
  ) => Effect.Effect<RemoteMemoryRepositoryRecallResultV1, RemoteMemoryRepositoryError>;
  readonly transitionHandoff: (
    request: RemoteMemoryRepositoryHandoffLifecycleRequestV1,
  ) => Effect.Effect<RemoteMemoryRepositoryHandoffLifecycleOutcomeV1, RemoteMemoryRepositoryError>;
}
