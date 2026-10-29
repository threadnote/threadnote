import {Array as EffectArray} from 'effect';
import {normalizeRemoteCitationSources, type RemoteCitationSource} from '@threadnote/memory/remote/citation_sources';
import type {MemoryRelation} from '@threadnote/memory/document';
import {parseRemoteRememberInputV1, type RemoteRememberInputV1} from '@threadnote/memory/remote/contracts';
import {parseRemoteMemoryReceiptV1, type RemoteMemoryReceiptV1} from '@threadnote/memory/remote/receipts';
import {normalizeRemoteMemoryRelations} from '@threadnote/memory/remote/relations';
import {inspectRemoteMemoryContent} from '@threadnote/memory/remote/content';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {remoteMemoryError} from './errors.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const REMOTE_MEMORY_PROPOSAL_VERSION = 1 as const;
export const REMOTE_MEMORY_PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'conflict', 'expired'] as const;
export const REMOTE_MEMORY_PROPOSAL_RETENTION_DAYS = 30;
export const REMOTE_MEMORY_PROPOSAL_CLAIM_LEASE_MILLISECONDS = 5 * 60_000;
export const REMOTE_MEMORY_PROPOSAL_PAYLOAD_MAX_BYTES = 1_100_000;
export const REMOTE_MEMORY_PROPOSAL_STORED_PAYLOAD_MAX_BYTES = REMOTE_MEMORY_PROPOSAL_PAYLOAD_MAX_BYTES + 16_384;

export type RemoteMemoryProposalStatus = (typeof REMOTE_MEMORY_PROPOSAL_STATUSES)[number];

export interface StoredRemoteMemoryProposalRow {
  readonly approval_revision_id: string | null;
  readonly approval_source_agent_client: 'cursor' | 'remote' | null;
  readonly created_at: Date;
  readonly decision_claimed_at: Date | null;
  readonly decision_kind: 'approve' | 'reject' | null;
  readonly decision_operation_id: string | null;
  readonly decision_request_hash: string | null;
  readonly expires_at: Date;
  readonly id: string;
  readonly payload: unknown | null;
  readonly payload_purged_at: Date | null;
  readonly project: string;
  readonly proposer_principal_id: string;
  readonly request_hash: string;
  readonly result_receipt: unknown | null;
  readonly reviewed_at: Date | null;
  readonly reviewer_principal_id: string | null;
  readonly reviewer_workload_attestation_id: string | null;
  readonly revision: string;
  readonly status: RemoteMemoryProposalStatus;
  readonly topic: string;
}

export type StoredRemoteMemoryProposalSummaryRow = Pick<
  StoredRemoteMemoryProposalRow,
  | 'created_at'
  | 'expires_at'
  | 'id'
  | 'project'
  | 'proposer_principal_id'
  | 'request_hash'
  | 'revision'
  | 'status'
  | 'topic'
>;

export interface RemoteDurableProposalInputV1 {
  readonly attestationId?: string;
  readonly baseRevision?: string;
  readonly operationId: string;
  readonly project: string;
  readonly relations?: readonly MemoryRelation[];
  readonly citationSources?: readonly RemoteCitationSource[];
  readonly replaceUri?: string;
  readonly text: string;
  readonly topic: string;
  readonly version: 1;
}

export interface RemoteDurableProposalPayloadV1 {
  readonly baseRevision?: string;
  readonly project: string;
  readonly relations?: readonly MemoryRelation[];
  readonly citationSources?: readonly RemoteCitationSource[];
  readonly replaceUri?: string;
  readonly text: string;
  readonly topic: string;
  readonly version: 1;
}

export interface RemoteMemoryProposalReceiptV1 {
  readonly expiresAt: string;
  readonly proposalId: string;
  readonly requestHash: string;
  readonly revision: string;
  readonly status: RemoteMemoryProposalStatus;
  readonly version: 1;
}

export interface RemoteMemoryProposalSummaryV1 extends RemoteMemoryProposalReceiptV1 {
  readonly createdAt: string;
  readonly project: string;
  readonly proposerPrincipalId: string;
  readonly topic: string;
}

export interface RemoteMemoryProposalV1 extends RemoteMemoryProposalSummaryV1 {
  readonly payload?: RemoteDurableProposalPayloadV1;
  readonly result?: RemoteMemoryReceiptV1;
  readonly reviewedAt?: string;
  readonly reviewerPrincipalId?: string;
}

export interface RemoteMemoryProposalListInputV1 {
  readonly afterProposalId?: string;
  readonly limit: number;
  readonly project?: string;
  readonly status?: RemoteMemoryProposalStatus;
  readonly version: 1;
}

export interface RemoteMemoryProposalReviewInputV1 {
  readonly attestationId?: string;
  readonly decision: 'approve' | 'reject';
  readonly operationId: string;
  readonly proposalId: string;
  readonly reason?: string;
  readonly revision: string;
  readonly version: 1;
}

export function remoteDurableProposalRequestHash(input: {
  readonly operationId: string;
  readonly payload: RemoteDurableProposalPayloadV1;
  readonly principalId: string;
  readonly shareId: string;
  readonly tenantId: string;
}): string {
  const relations = normalizeRemoteMemoryRelations(input.payload.relations);
  const citationSources = normalizeRemoteCitationSources(input.payload.citationSources);
  return sha256HexSync(
    JSON.stringify({
      operationId: input.operationId,
      payload: {
        ...input.payload,
        ...(relations === undefined ? {} : {relations}),
        ...(citationSources === undefined ? {} : {citationSources}),
      },
      principalId: input.principalId,
      shareId: input.shareId,
      tenantId: input.tenantId,
      version: 1,
    }),
  );
}

export function durableProposalPayload(
  input: RemoteRememberInputV1 | RemoteDurableProposalInputV1,
): RemoteDurableProposalPayloadV1 {
  const text = Effect.pipe(input.text, EffectString.trim);
  if (!text) throw remoteMemoryError('invalid_request', 'A durable memory proposal requires non-empty text.');
  const inspected = inspectRemoteMemoryContent(text);
  if (!inspected.allowed) {
    throw remoteMemoryError('invalid_request', `Remote memory content was blocked by ${inspected.category} policy.`);
  }
  const payload: RemoteDurableProposalPayloadV1 = {
    ...(input.baseRevision === undefined ? {} : {baseRevision: input.baseRevision}),
    ...(input.citationSources === undefined
      ? {}
      : {citationSources: normalizeRemoteCitationSources(input.citationSources)!}),
    project: input.project,
    ...(input.relations === undefined ? {} : {relations: input.relations}),
    ...(input.replaceUri === undefined ? {} : {replaceUri: input.replaceUri}),
    text: inspected.canonicalContent,
    topic: input.topic,
    version: 1,
  };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > REMOTE_MEMORY_PROPOSAL_PAYLOAD_MAX_BYTES) {
    throw remoteMemoryError('invalid_request', 'The durable memory proposal payload exceeds the size limit.');
  }
  return payload;
}

export function durableProposalRememberInput(
  input: RemoteDurableProposalInputV1 | RemoteDurableProposalPayloadV1,
  operationId: string,
): RemoteRememberInputV1 {
  return {
    ...(input.baseRevision === undefined ? {} : {baseRevision: input.baseRevision}),
    kind: 'durable',
    operationId,
    ...(input.citationSources === undefined
      ? {}
      : {citationSources: normalizeRemoteCitationSources(input.citationSources)!}),
    project: input.project,
    ...(input.relations === undefined ? {} : {relations: input.relations}),
    ...(input.replaceUri === undefined ? {} : {replaceUri: input.replaceUri}),
    text: input.text,
    topic: input.topic,
    version: 1,
  };
}

export function durableProposalApprovalOperationId(
  proposal: Pick<StoredRemoteMemoryProposalRow, 'id' | 'revision'>,
): string {
  return `proposal-approve:${proposal.id}:${proposal.revision}`;
}

export function remoteMemoryProposalFromRow(row: StoredRemoteMemoryProposalRow): RemoteMemoryProposalV1 {
  return {
    ...remoteMemoryProposalSummaryFromRow(row),
    ...(row.payload === null ? {} : {payload: durableProposalPayloadFromUnknown(row.payload)}),
    ...(row.result_receipt === null ? {} : {result: parseRemoteMemoryReceiptV1(row.result_receipt)}),
    ...(row.reviewed_at === null ? {} : {reviewedAt: row.reviewed_at.toISOString()}),
    ...(row.reviewer_principal_id === null ? {} : {reviewerPrincipalId: row.reviewer_principal_id}),
  };
}

export function remoteMemoryProposalReceiptFromRow(
  row: StoredRemoteMemoryProposalSummaryRow,
): RemoteMemoryProposalReceiptV1 {
  return {
    expiresAt: row.expires_at.toISOString(),
    proposalId: row.id,
    requestHash: row.request_hash,
    revision: row.revision,
    status: row.status,
    version: 1,
  };
}

export function remoteMemoryProposalSummaryFromRow(
  row: StoredRemoteMemoryProposalSummaryRow,
): RemoteMemoryProposalSummaryV1 {
  return {
    ...remoteMemoryProposalReceiptFromRow(row),
    createdAt: row.created_at.toISOString(),
    project: row.project,
    proposerPrincipalId: row.proposer_principal_id,
    topic: row.topic,
  };
}

export function durableProposalPayloadFromUnknown(value: unknown): RemoteDurableProposalPayloadV1 {
  try {
    const parsed = parseRemoteRememberInputV1({
      ...(typeof value === 'object' && value !== null && !EffectArray.isArray(value) ? value : {}),
      kind: 'durable',
      operationId: 'proposal-payload-validation',
      version: 1,
    });
    return durableProposalPayload(parsed);
  } catch {
    throw remoteMemoryError('service_unavailable', 'The stored durable memory proposal is invalid.');
  }
}

export function normalizedProposalReviewReason(input: RemoteMemoryProposalReviewInputV1): string | undefined {
  const reason = Effect.pipe(input.reason, effectOptionalString =>
    effectOptionalString == null ? undefined : Effect.pipe(effectOptionalString, EffectString.trim),
  );
  if (input.decision === 'reject' && !reason) {
    throw remoteMemoryError('invalid_request', 'A rejection requires a non-empty reason.');
  }
  return reason || undefined;
}

export function remoteProposalReviewRequestHash(input: {
  readonly attestationId?: string;
  readonly principal: AuthorizedProposalReviewer;
  readonly review: RemoteMemoryProposalReviewInputV1;
}): string {
  return sha256HexSync(
    JSON.stringify({
      decision: input.review.decision,
      attestationId: input.attestationId ?? null,
      operationId: input.review.operationId,
      principalId: input.principal.principalId,
      proposalId: input.review.proposalId,
      reason: normalizedProposalReviewReason(input.review) ?? null,
      revision: input.review.revision,
      shareId: input.principal.shareId,
      tenantId: input.principal.tenantId,
      version: 1,
    }),
  );
}

interface AuthorizedProposalReviewer {
  readonly principalId: string;
  readonly shareId: string;
  readonly tenantId: string;
}
