import type {ISql} from 'postgres';
import type {RemoteMemoryReceiptV1} from '@threadnote/memory/remote/receipts';
import {randomUuidV4} from '@threadnote/platform/uuid';
import type {AuthorizedRemotePrincipal} from '../authorization.js';
import {remoteMemoryError} from '../errors.js';
import {requireJsonValue} from '../json.js';
import {
  remoteMemoryProposalFromRow,
  remoteMemoryProposalSummaryFromRow,
  normalizedProposalReviewReason,
  remoteProposalReviewRequestHash,
  REMOTE_MEMORY_PROPOSAL_CLAIM_LEASE_MILLISECONDS,
  type RemoteMemoryProposalListInputV1,
  type RemoteMemoryProposalReviewInputV1,
  type RemoteMemoryProposalStatus,
  type RemoteMemoryProposalSummaryV1,
  type RemoteMemoryProposalV1,
  type StoredRemoteMemoryProposalRow,
  type StoredRemoteMemoryProposalSummaryRow,
} from '../proposals.js';
import {requirePrincipalProject, requireShareState} from '../repository_policy.js';
import {Array as EffectArray} from 'effect';

export type ProposalTenantRunner = <A>(use: (transaction: ISql) => Promise<A>) => Promise<A>;

export interface StoredProposalApprovalContext {
  readonly proposal: StoredRemoteMemoryProposalRow;
  readonly review: RemoteMemoryProposalReviewInputV1;
  readonly reviewedAt: Date;
}

export type StoredProposalReviewClaim =
  | {
      readonly kind: 'claimed';
      readonly review: RemoteMemoryProposalReviewInputV1;
      readonly row: StoredRemoteMemoryProposalRow;
    }
  | {readonly kind: 'decided'; readonly proposal: RemoteMemoryProposalV1}
  | {readonly kind: 'expired'; readonly proposal: RemoteMemoryProposalV1}
  | {readonly kind: 'replay'; readonly proposal: RemoteMemoryProposalV1};

export async function claimStoredRemoteMemoryProposalReview(input: {
  readonly attestationId?: string;
  readonly beforeRead: (transaction: ISql) => Promise<void>;
  readonly now: Date;
  readonly principal: AuthorizedRemotePrincipal;
  readonly review: RemoteMemoryProposalReviewInputV1;
  readonly validate: (transaction: ISql, proposal: StoredRemoteMemoryProposalRow) => Promise<void>;
  readonly withTenant: ProposalTenantRunner;
}): Promise<StoredProposalReviewClaim> {
  const normalizedReason = normalizedProposalReviewReason(input.review);
  const {reason: _reason, ...reviewWithoutReason} = input.review;
  const review: RemoteMemoryProposalReviewInputV1 = normalizedReason
    ? {...reviewWithoutReason, reason: normalizedReason}
    : reviewWithoutReason;
  const reviewRequestHash = remoteProposalReviewRequestHash({
    ...(input.attestationId ? {attestationId: input.attestationId} : {}),
    principal: input.principal,
    review,
  });
  return input.withTenant(async transaction => {
    await input.beforeRead(transaction);
    const rows = await transaction<StoredRemoteMemoryProposalRow[]>`
      SELECT * FROM remote_memory.durable_memory_proposals
      WHERE tenant_id = ${input.principal.tenantId} AND share_id = ${input.principal.shareId}
        AND id = ${review.proposalId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw remoteMemoryError('not_found', 'The durable memory proposal was not found.');
    if (row.revision !== review.revision) {
      throw remoteMemoryError('conflict', 'The durable memory proposal revision changed.', {
        currentRevision: row.revision,
        reason: 'stale_proposal_revision',
      });
    }
    if (row.proposer_principal_id === input.principal.principalId) {
      throw remoteMemoryError('forbidden', 'A durable memory proposal requires an independent reviewer.');
    }
    requirePrincipalProject(input.principal, row.project);
    await input.validate(transaction, row);
    if (row.status !== 'pending') {
      if (
        row.decision_kind === review.decision &&
        row.decision_operation_id === review.operationId &&
        row.reviewer_principal_id === input.principal.principalId &&
        row.decision_request_hash !== reviewRequestHash
      ) {
        throw remoteMemoryError('idempotency_mismatch', 'The review operation id was already used.');
      }
      if (
        row.decision_kind === review.decision &&
        row.decision_operation_id === review.operationId &&
        row.decision_request_hash === reviewRequestHash &&
        row.reviewer_principal_id === input.principal.principalId
      ) {
        return {kind: 'replay', proposal: remoteMemoryProposalFromRow(row)};
      }
      throw remoteMemoryError('conflict', 'The durable memory proposal already has a terminal decision.', {
        reason: 'proposal_already_decided',
        status: row.status,
      });
    }
    const proposalExpired = row.expires_at.getTime() <= input.now.getTime();
    if (proposalExpired && row.decision_operation_id === null) {
      return expireStoredRemoteMemoryProposal(transaction, input.principal, row, input.now);
    }
    if (row.decision_operation_id !== null) {
      const claimLeaseExpired =
        row.decision_claimed_at !== null &&
        row.decision_claimed_at.getTime() + REMOTE_MEMORY_PROPOSAL_CLAIM_LEASE_MILLISECONDS <= input.now.getTime();
      if (
        row.decision_kind === review.decision &&
        row.decision_operation_id === review.operationId &&
        row.reviewer_principal_id === input.principal.principalId &&
        row.decision_request_hash !== reviewRequestHash
      ) {
        throw remoteMemoryError('idempotency_mismatch', 'The review operation id was already used.');
      }
      if (
        row.decision_kind === review.decision &&
        row.decision_operation_id === review.operationId &&
        row.decision_request_hash === reviewRequestHash &&
        row.reviewer_principal_id === input.principal.principalId
      ) {
        if (proposalExpired && claimLeaseExpired) {
          return expireStoredRemoteMemoryProposal(transaction, input.principal, row, input.now);
        }
        return {kind: 'claimed', review, row};
      }
      const claimExpired = row.decision_kind === 'approve' && review.decision === 'approve' && claimLeaseExpired;
      if (!claimExpired) {
        throw remoteMemoryError('conflict', 'The durable memory proposal is being reviewed.', {
          reason: 'proposal_review_in_progress',
        });
      }
      if (proposalExpired) {
        return expireStoredRemoteMemoryProposal(transaction, input.principal, row, input.now);
      }
      const takenOver = await transaction<StoredRemoteMemoryProposalRow[]>`
        UPDATE remote_memory.durable_memory_proposals SET
          decision_operation_id = ${review.operationId}, decision_request_hash = ${reviewRequestHash},
          reviewer_principal_id = ${input.principal.principalId},
          reviewer_workload_attestation_id = ${input.attestationId ?? null},
          decision_claimed_at = ${input.now.toISOString()}
        WHERE tenant_id = ${input.principal.tenantId} AND share_id = ${input.principal.shareId} AND id = ${row.id}
          AND status = 'pending' AND decision_operation_id = ${row.decision_operation_id}
        RETURNING *
      `;
      return {kind: 'claimed', review, row: takenOver[0]};
    }
    if (review.decision === 'reject') {
      const rejected = await transaction<StoredRemoteMemoryProposalRow[]>`
        UPDATE remote_memory.durable_memory_proposals SET
          status = 'rejected', decision_kind = 'reject', decision_operation_id = ${review.operationId},
          decision_request_hash = ${reviewRequestHash}, reviewer_principal_id = ${input.principal.principalId},
          reviewer_workload_attestation_id = ${input.attestationId ?? null},
          decision_claimed_at = ${input.now.toISOString()}, decision_reason = ${normalizedReason ?? null},
          reviewed_at = ${input.now.toISOString()}
        WHERE tenant_id = ${input.principal.tenantId} AND share_id = ${input.principal.shareId} AND id = ${row.id}
          AND status = 'pending' AND decision_operation_id IS NULL
        RETURNING *
      `;
      return {kind: 'decided', proposal: remoteMemoryProposalFromRow(rejected[0])};
    }
    const updated = await transaction<StoredRemoteMemoryProposalRow[]>`
      UPDATE remote_memory.durable_memory_proposals SET
        decision_kind = 'approve', decision_operation_id = ${review.operationId},
        decision_request_hash = ${reviewRequestHash}, reviewer_principal_id = ${input.principal.principalId},
        reviewer_workload_attestation_id = ${input.attestationId ?? null},
        decision_claimed_at = ${input.now.toISOString()}, approval_revision_id = ${randomUuidV4()},
        approval_source_agent_client = ${input.attestationId ? 'cursor' : 'remote'}
      WHERE tenant_id = ${input.principal.tenantId} AND share_id = ${input.principal.shareId} AND id = ${row.id}
        AND status = 'pending' AND decision_operation_id IS NULL
      RETURNING *
    `;
    return {kind: 'claimed', review, row: updated[0]};
  });
}

async function expireStoredRemoteMemoryProposal(
  transaction: ISql,
  principal: AuthorizedRemotePrincipal,
  row: StoredRemoteMemoryProposalRow,
  now: Date,
): Promise<StoredProposalReviewClaim> {
  const expired = await transaction<StoredRemoteMemoryProposalRow[]>`
    UPDATE remote_memory.durable_memory_proposals SET
      status = 'expired', payload = NULL, payload_purged_at = ${now.toISOString()},
      reviewed_at = COALESCE(reviewed_at, ${now.toISOString()})
    WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId} AND id = ${row.id}
      AND status = 'pending'
    RETURNING *
  `;
  return {kind: 'expired', proposal: remoteMemoryProposalFromRow(expired[0] ?? row)};
}

export async function listStoredRemoteMemoryProposals(
  principal: AuthorizedRemotePrincipal,
  input: RemoteMemoryProposalListInputV1,
  withTenant: ProposalTenantRunner,
): Promise<{readonly entries: readonly RemoteMemoryProposalSummaryV1[]; readonly nextProposalId?: string}> {
  return withTenant(async transaction => {
    await requireShareState(transaction, principal);
    const allowedProjects = principal.allowedProjects === 'all' ? [] : [...principal.allowedProjects];
    const rows = await transaction<StoredRemoteMemoryProposalSummaryRow[]>`
      SELECT created_at, expires_at, id, project, proposer_principal_id, request_hash, revision, status, topic
      FROM remote_memory.durable_memory_proposals
      WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId}
        AND (${principal.allowedProjects === 'all'} OR project = ANY(${transaction.array(allowedProjects)}))
        AND (${input.project ?? null}::text IS NULL OR project = ${input.project ?? null})
        AND (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
        AND (status <> 'pending' OR expires_at > now())
        AND (${input.afterProposalId ?? null}::text IS NULL OR id > ${input.afterProposalId ?? null})
      ORDER BY id
      LIMIT ${input.limit + 1}
    `;
    const visible = rows.slice(0, input.limit);
    return {
      entries: EffectArray.map(visible, remoteMemoryProposalSummaryFromRow),
      ...(rows.length > input.limit && visible.at(-1) ? {nextProposalId: visible.at(-1)!.id} : {}),
    };
  });
}

export async function readStoredRemoteMemoryProposal(
  principal: AuthorizedRemotePrincipal,
  proposalId: string,
  withTenant: ProposalTenantRunner,
): Promise<RemoteMemoryProposalV1> {
  return withTenant(async transaction => {
    await requireShareState(transaction, principal);
    const rows = await transaction<StoredRemoteMemoryProposalRow[]>`
      SELECT * FROM remote_memory.durable_memory_proposals
      WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId} AND id = ${proposalId}
    `;
    const row = rows[0];
    if (!row) throw remoteMemoryError('not_found', 'The durable memory proposal was not found.');
    requirePrincipalProject(principal, row.project);
    return remoteMemoryProposalFromRow(row);
  });
}

export async function finishStoredRemoteMemoryProposalDecision(
  principal: AuthorizedRemotePrincipal,
  proposal: StoredRemoteMemoryProposalRow,
  input: RemoteMemoryProposalReviewInputV1,
  status: Exclude<RemoteMemoryProposalStatus, 'pending'>,
  result: RemoteMemoryReceiptV1 | undefined,
  now: Date,
  withTenant: ProposalTenantRunner,
  validate: (transaction: ISql) => Promise<void>,
): Promise<RemoteMemoryProposalV1> {
  return withTenant(async transaction => {
    await validate(transaction);
    return finishStoredRemoteMemoryProposalDecisionInTransaction(
      transaction,
      principal,
      proposal,
      input,
      status,
      result,
      now,
    );
  });
}

export async function finishStoredRemoteMemoryProposalDecisionInTransaction(
  transaction: ISql,
  principal: AuthorizedRemotePrincipal,
  proposal: StoredRemoteMemoryProposalRow,
  input: RemoteMemoryProposalReviewInputV1,
  status: Exclude<RemoteMemoryProposalStatus, 'pending'>,
  result: RemoteMemoryReceiptV1 | undefined,
  now: Date,
): Promise<RemoteMemoryProposalV1> {
  const rows = await transaction<StoredRemoteMemoryProposalRow[]>`
    UPDATE remote_memory.durable_memory_proposals SET
      status = ${status}, decision_reason = ${input.reason ?? null},
      result_receipt = ${result ? transaction.json(requireJsonValue(result)) : null}, reviewed_at = ${now.toISOString()}
    WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId} AND id = ${proposal.id}
      AND status = 'pending' AND revision = ${input.revision}
      AND decision_kind = ${input.decision} AND decision_operation_id = ${input.operationId}
      AND decision_request_hash = ${proposal.decision_request_hash}
      AND reviewer_principal_id = ${principal.principalId}
    RETURNING *
  `;
  const decided = rows[0];
  if (!decided) {
    throw remoteMemoryError('conflict', 'The durable memory proposal decision could not be committed.', {
      reason: 'proposal_decision_conflict',
    });
  }
  return remoteMemoryProposalFromRow(decided);
}
