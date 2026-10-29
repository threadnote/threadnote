import {Schema} from 'effect';
import type {RemoteMemoryKind} from './contracts.js';
import type {RemoteMemoryReceiptV1} from './receipts.js';

export const REMOTE_MEMORY_REVISION_VERSION = 1 as const;

export type RemoteMemoryHeadStatus = 'active' | 'archived' | 'expired' | 'superseded';

export interface RemoteMemoryLogicalIdentityV1 {
  readonly kind: RemoteMemoryKind;
  readonly project: string;
  readonly shareId: string;
  readonly tenantId: string;
  readonly topic: string;
  readonly version: typeof REMOTE_MEMORY_REVISION_VERSION;
}

export interface RemoteMemoryHeadV1 {
  readonly logicalKey: string;
  readonly revision: string;
  readonly status: RemoteMemoryHeadStatus;
  readonly version: typeof REMOTE_MEMORY_REVISION_VERSION;
}

export interface RemoteIdempotencyKeyV1 {
  readonly operationId: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly version: typeof REMOTE_MEMORY_REVISION_VERSION;
}

export interface RemoteIdempotencyRecordV1 {
  readonly fingerprint: string;
  readonly key: RemoteIdempotencyKeyV1;
  readonly outcome: RemoteMemoryReceiptV1;
  readonly version: typeof REMOTE_MEMORY_REVISION_VERSION;
}

export interface RemoteMutationIntentV1 {
  readonly baseRevision?: string;
  readonly fingerprint: string;
  readonly idempotencyKey: RemoteIdempotencyKeyV1;
  readonly logicalKey: string;
  readonly proposedRevision: string;
  readonly version: typeof REMOTE_MEMORY_REVISION_VERSION;
}

export interface RemoteCommittedMutationV1 {
  readonly baseRevision?: string;
  readonly logicalKey: string;
  readonly revision: string;
  readonly shareGeneration: number;
  readonly version: typeof REMOTE_MEMORY_REVISION_VERSION;
}

export type RemoteMutationConflictReason = 'already_exists' | 'missing_head' | 'stale_base';

export type RemoteMutationDecisionV1 =
  | {
      readonly kind: 'commit';
      readonly mutation: RemoteCommittedMutationV1;
      readonly version: typeof REMOTE_MEMORY_REVISION_VERSION;
    }
  | {
      readonly currentRevision?: string;
      readonly kind: 'conflict';
      readonly reason: RemoteMutationConflictReason;
      readonly shareGeneration: number;
      readonly version: typeof REMOTE_MEMORY_REVISION_VERSION;
    }
  | {
      readonly kind: 'idempotency_conflict';
      readonly operationId: string;
      readonly shareGeneration: number;
      readonly version: typeof REMOTE_MEMORY_REVISION_VERSION;
    }
  | {
      readonly kind: 'replay';
      readonly outcome: RemoteMemoryReceiptV1;
      readonly version: typeof REMOTE_MEMORY_REVISION_VERSION;
    };

export class InvalidRemoteMutation extends Schema.TaggedError<InvalidRemoteMutation, {readonly brand: unique symbol}>()(
  'InvalidRemoteMutation',
  {
    message: Schema.String,
  },
) {}

export function formatRemoteMemoryLogicalKey(identity: RemoteMemoryLogicalIdentityV1): string {
  if (identity.version !== REMOTE_MEMORY_REVISION_VERSION) invalid('unsupported logical-identity version');
  return `remote-memory-key-v1:${JSON.stringify([
    identity.tenantId,
    identity.shareId,
    identity.kind,
    identity.project,
    identity.topic,
  ])}`;
}

export function planRemoteMutation(input: {
  readonly currentShareGeneration: number;
  readonly head?: RemoteMemoryHeadV1;
  readonly idempotencyRecord?: RemoteIdempotencyRecordV1;
  readonly intent: RemoteMutationIntentV1;
}): RemoteMutationDecisionV1 {
  validateMutationInput(input);
  const {head, idempotencyRecord, intent} = input;
  if (idempotencyRecord) {
    if (!idempotencyKeysEqual(idempotencyRecord.key, intent.idempotencyKey)) {
      return invalid('idempotency repository returned a record from another scope');
    }
    if (idempotencyRecord.fingerprint === intent.fingerprint) {
      return {kind: 'replay', outcome: idempotencyRecord.outcome, version: REMOTE_MEMORY_REVISION_VERSION};
    }
    return {
      kind: 'idempotency_conflict',
      operationId: intent.idempotencyKey.operationId,
      shareGeneration: input.currentShareGeneration,
      version: REMOTE_MEMORY_REVISION_VERSION,
    };
  }

  if (head && head.logicalKey !== intent.logicalKey) return invalid('locked memory head does not match the intent key');
  if (intent.baseRevision === undefined) {
    if (head) return conflict('already_exists', input.currentShareGeneration, head.revision);
    return commit(intent, input.currentShareGeneration);
  }
  if (!head) return conflict('missing_head', input.currentShareGeneration);
  if (head.revision !== intent.baseRevision) {
    return conflict('stale_base', input.currentShareGeneration, head.revision);
  }
  if (head.revision === intent.proposedRevision) return invalid('a new immutable revision must have a distinct ID');
  return commit(intent, input.currentShareGeneration);
}

export function applyRemoteMutationDecision(input: {
  readonly decision: RemoteMutationDecisionV1;
  readonly status?: RemoteMemoryHeadStatus;
}): {readonly head: RemoteMemoryHeadV1; readonly shareGeneration: number} {
  if (input.decision.kind !== 'commit') return invalid('only a committed mutation can update a head');
  return {
    head: {
      logicalKey: input.decision.mutation.logicalKey,
      revision: input.decision.mutation.revision,
      status: input.status ?? 'active',
      version: REMOTE_MEMORY_REVISION_VERSION,
    },
    shareGeneration: input.decision.mutation.shareGeneration,
  };
}

function commit(intent: RemoteMutationIntentV1, currentShareGeneration: number): RemoteMutationDecisionV1 {
  if (currentShareGeneration === Number.MAX_SAFE_INTEGER) return invalid('share generation is exhausted');
  return {
    kind: 'commit',
    mutation: {
      ...(intent.baseRevision === undefined ? {} : {baseRevision: intent.baseRevision}),
      logicalKey: intent.logicalKey,
      revision: intent.proposedRevision,
      shareGeneration: currentShareGeneration + 1,
      version: REMOTE_MEMORY_REVISION_VERSION,
    },
    version: REMOTE_MEMORY_REVISION_VERSION,
  };
}

function conflict(
  reason: RemoteMutationConflictReason,
  shareGeneration: number,
  currentRevision?: string,
): RemoteMutationDecisionV1 {
  return {
    ...(currentRevision === undefined ? {} : {currentRevision}),
    kind: 'conflict',
    reason,
    shareGeneration,
    version: REMOTE_MEMORY_REVISION_VERSION,
  };
}

function idempotencyKeysEqual(left: RemoteIdempotencyKeyV1, right: RemoteIdempotencyKeyV1): boolean {
  return (
    left.version === right.version &&
    left.operationId === right.operationId &&
    left.principalId === right.principalId &&
    left.tenantId === right.tenantId
  );
}

function validateMutationInput(input: {
  readonly currentShareGeneration: number;
  readonly head?: RemoteMemoryHeadV1;
  readonly idempotencyRecord?: RemoteIdempotencyRecordV1;
  readonly intent: RemoteMutationIntentV1;
}): void {
  if (!Number.isSafeInteger(input.currentShareGeneration) || input.currentShareGeneration < 0) {
    invalid('current share generation must be a non-negative safe integer');
  }
  if (input.intent.version !== REMOTE_MEMORY_REVISION_VERSION) invalid('unsupported mutation-intent version');
  if (input.head?.version !== undefined && input.head.version !== REMOTE_MEMORY_REVISION_VERSION) {
    invalid('unsupported memory-head version');
  }
  if (
    input.idempotencyRecord?.version !== undefined &&
    input.idempotencyRecord.version !== REMOTE_MEMORY_REVISION_VERSION
  ) {
    invalid('unsupported idempotency-record version');
  }
  for (const [label, value] of [
    ['fingerprint', input.intent.fingerprint],
    ['logical key', input.intent.logicalKey],
    ['operation ID', input.intent.idempotencyKey.operationId],
    ['principal ID', input.intent.idempotencyKey.principalId],
    ['proposed revision', input.intent.proposedRevision],
    ['tenant ID', input.intent.idempotencyKey.tenantId],
  ] as const) {
    if (!value) invalid(`${label} must not be empty`);
  }
}

function invalid(message: string): never {
  throw InvalidRemoteMutation.make({message: `Invalid remote mutation: ${message}.`});
}
