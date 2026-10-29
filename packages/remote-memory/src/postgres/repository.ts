import {Array as EffectArray} from 'effect';
import {requestFingerprint} from '../remember/fingerprint.js';
import {resolveRemoteCitationSources} from '../citation_sources.js';
import {ingestGitShare} from '../git/ingest.js';
import {
  requireShareState,
  requireActiveProject,
  requireFreshAttestationPolicy,
  principalAllows,
  requirePrincipalProject,
  type ShareStateRow,
} from '../repository_policy.js';
import {Schema} from 'effect';
import type {ReservedSql, Sql, ISql} from 'postgres';
import {randomUuidV4} from '@threadnote/platform/uuid';
import {parseMemoryDocument, type MemoryRelation} from '@threadnote/memory/document';
import {formatRemoteMemoryUri, parseRemoteShareAddress} from '@threadnote/memory/remote/address';
import type {RemoteReadInputV1, RemoteRecallInputV1, RemoteRememberInputV1} from '@threadnote/memory/remote/contracts';
import {
  transitionRemoteHandoffLifecycle,
  type RemoteHandoffLifecycleOperation,
} from '@threadnote/memory/remote/lifecycle';
import {
  formatRemoteMemoryLogicalKey,
  planRemoteMutation,
  REMOTE_MEMORY_REVISION_VERSION,
  type RemoteMemoryHeadV1,
  type RemoteMutationIntentV1,
} from '@threadnote/memory/remote/revisions';
import type {RemoteMemoryReceiptV1} from '@threadnote/memory/remote/receipts';
import {
  assertRemoteRememberReplacementTarget,
  authorizeRemoteRememberRelations,
  REMOTE_MEMORY_FEATURE_FLAGS,
  REMOTE_MEMORY_SCOPES,
  type AuthorizedRemotePrincipal,
  type RemoteMemoryFeatureFlag,
  type RemoteMemoryScope,
} from '../authorization.js';

const remoteMemoryScopeSet: ReadonlySet<string> = new Set(REMOTE_MEMORY_SCOPES);
const remoteMemoryFeatureFlagSet: ReadonlySet<string> = new Set(REMOTE_MEMORY_FEATURE_FLAGS);
import type {CursorWorkloadAttestation} from '../cursor_oidc.js';
import {RemoteMemoryError, remoteMemoryError} from '../errors.js';
import {
  GIT_REF_UPDATE_TIMEOUT_MILLISECONDS,
  GitCanonicalMemoryStore,
  gitCanonicalSharePath,
} from '../git/canonical_store.js';
import {requireJsonValue} from '../json.js';
import {assertGitMemoryBinding, requireGitMemoryBinding} from '../git/binding.js';
import {remoteGitIngestPrincipalId} from '../git/ingest_principal.js';
import {makeRemoteDocument} from '../remote_document.js';
import {
  isRetryableProposalOperationOutcome,
  readStoredOperationOutcome,
  storedOperationRejection,
} from '../operation_outcome.js';
import {
  recordRememberPublicationPlan,
  storedRememberPublicationPlan,
  storedRememberPublicationPlanDate,
  type StoredRememberPublicationPlanV1,
} from '../remember/publication_recovery.js';
import {
  remoteMemoryDatabaseTimeoutMilliseconds,
  requireActiveRemoteMemoryRequest,
  withRemoteMemoryRequestCancellation,
  type RemoteMemoryRequestExecution,
} from '../request_execution.js';
import {acquireRemoteRelationAdmissionTransactionLock, remoteRelationAdmissionLockKey} from '../relation_admission.js';
import {replaceRemoteCodeLinkBacklinks} from '../code_link_backlinks.js';
import type {RemoteContextBriefInputV1} from '../context/brief.js';
import {compileRemoteContextBrief, type RemoteMemoryContextBriefResult} from '../context/brief_repository.js';
import {remoteMemoryExcerpt, remoteRecallTextMatches} from '../recall/text.js';
import {
  claimStoredRemoteMemoryProposalReview,
  finishStoredRemoteMemoryProposalDecision,
  finishStoredRemoteMemoryProposalDecisionInTransaction,
  listStoredRemoteMemoryProposals,
  readStoredRemoteMemoryProposal,
  type StoredProposalApprovalContext,
} from './proposals.js';
import {
  durableProposalApprovalOperationId,
  durableProposalPayload,
  durableProposalPayloadFromUnknown,
  durableProposalRememberInput,
  remoteDurableProposalRequestHash,
  REMOTE_MEMORY_PROPOSAL_RETENTION_DAYS,
  remoteMemoryProposalReceiptFromRow,
  type RemoteDurableProposalInputV1,
  type RemoteMemoryProposalListInputV1,
  type RemoteMemoryProposalReceiptV1,
  type RemoteMemoryProposalReviewInputV1,
  type RemoteMemoryProposalStatus,
  type RemoteMemoryProposalSummaryV1,
  type RemoteMemoryProposalV1,
  type StoredRemoteMemoryProposalRow,
} from '../proposals.js';
import {
  lifecycleRequestFingerprint,
  makeLifecycleDocument,
  mutationActor,
  mutationAuthorityValidThrough,
  numeric,
  receipt,
  resolveCanonicalUri,
} from './repository_support.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

interface HeadRow {
  readonly canonical_uri: string;
  readonly content_hash: string;
  readonly created_at: Date;
  readonly current_revision_id: string;
  readonly expires_at: Date | null;
  readonly git_commit: string | null;
  readonly git_path: string | null;
  readonly head_id: string;
  readonly kind: 'durable' | 'handoff';
  readonly markdown_body: string;
  readonly project: string;
  readonly retention_class: string | null;
  readonly status: 'active' | 'archived' | 'expired' | 'superseded';
  readonly topic: string;
  readonly updated_at: Date;
}
interface RecallRow extends HeadRow {
  readonly generation: string | number;
  readonly score: string | number;
}
interface IdempotencyRecordRow {
  readonly outcome: unknown | null;
  readonly outcome_expires_at: Date;
  readonly request_hash: string;
}

type OperationReplay = {readonly kind: 'replay'; readonly receipt: RemoteMemoryReceiptV1};
type OperationReservation =
  {readonly kind: 'execute'; readonly publicationPlan?: StoredRememberPublicationPlanV1} | OperationReplay;
type TenantTransactionRunner = <A>(
  tenantId: string,
  use: (transaction: ISql) => Promise<A>,
  execution?: RemoteMemoryRequestExecution,
) => Promise<A>;

const IDEMPOTENCY_REPLAY_WINDOW_MILLISECONDS = 24 * 60 * 60_000;

export interface RemoteMemoryReadResult {
  readonly content: string;
  readonly kind: 'durable' | 'handoff';
  readonly project: string;
  readonly receipt: RemoteMemoryReceiptV1;
  readonly status: 'active' | 'archived' | 'expired' | 'superseded';
  readonly topic: string;
  readonly uri: string;
}

export interface RemoteMemoryListEntry {
  readonly kind: 'durable' | 'handoff';
  readonly modifiedAt: string;
  readonly project: string;
  readonly revision: string;
  readonly status: 'active' | 'archived' | 'expired' | 'superseded';
  readonly topic: string;
  readonly uri: string;
}

export interface RemoteMemoryRecallResult {
  readonly excerpt: string;
  readonly kind: 'durable' | 'handoff';
  readonly project: string;
  readonly revision: string;
  readonly score: number;
  readonly status: 'active' | 'archived' | 'expired' | 'superseded';
  readonly topic: string;
  readonly uri: string;
}

export interface RemoteMemoryStatusResult {
  readonly receipt: RemoteMemoryReceiptV1;
  readonly reviewGated: Readonly<{readonly propose: boolean; readonly review: boolean}>;
  readonly writable: Readonly<{readonly durable: boolean; readonly handoff: boolean}>;
}

export interface RemoteHandoffTransitionInput {
  readonly baseRevision: string;
  readonly operation: RemoteHandoffLifecycleOperation;
  readonly operationId: string;
  readonly uri: string;
}

export class PostgresRemoteMemoryRepository {
  readonly gitStore?: GitCanonicalMemoryStore;
  readonly statementTimeoutMilliseconds: number;

  constructor(
    readonly sql: Sql,
    options: {readonly gitStore?: GitCanonicalMemoryStore; readonly statementTimeoutMilliseconds?: number} = {},
  ) {
    const timeout = options.statementTimeoutMilliseconds ?? 5_000;
    if (options.gitStore) requireGitMemoryBinding(options.gitStore.binding);
    this.gitStore = options.gitStore;
    this.statementTimeoutMilliseconds =
      Number.isSafeInteger(timeout) && timeout >= 100 && timeout <= 120_000 ? timeout : 5_000;
  }

  async status(
    principal: AuthorizedRemotePrincipal,
    requestId: string,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<RemoteMemoryStatusResult> {
    assertGitMemoryBinding(this.gitStore?.binding, principal);
    return this.withTenant(
      principal.tenantId,
      async transaction => {
        const state = await requireShareState(transaction, principal);
        return {
          receipt: receipt(principal, state, requestId),
          reviewGated: {
            propose: principalAllows(principal, 'memory:propose:durable', 'remote_memory_durable_write'),
            review: principalAllows(principal, 'memory:review:durable', 'remote_memory_durable_write'),
          },
          writable: {
            durable: principalAllows(principal, 'memory:write:durable', 'remote_memory_durable_write'),
            handoff: principalAllows(principal, 'memory:write:handoff', 'remote_memory_handoff_write'),
          },
        };
      },
      execution,
    );
  }

  async proposeDurable(
    principal: AuthorizedRemotePrincipal,
    input: RemoteDurableProposalInputV1,
    _requestId: string,
    attestation?: CursorWorkloadAttestation,
    now = new Date(),
    execution?: RemoteMemoryRequestExecution,
  ): Promise<RemoteMemoryProposalReceiptV1> {
    assertGitMemoryBinding(this.gitStore?.binding, principal);
    requirePrincipalProject(principal, input.project);
    const rememberInput = durableProposalRememberInput(input, input.operationId);
    assertRemoteRememberReplacementTarget(principal, rememberInput);
    const authorized = authorizeRemoteRememberRelations(principal, rememberInput);
    const payload = durableProposalPayload(authorized);
    const requestHash = remoteDurableProposalRequestHash({
      operationId: input.operationId,
      payload,
      principalId: principal.principalId,
      shareId: principal.shareId,
      tenantId: principal.tenantId,
    });
    return this.withTenant(
      principal.tenantId,
      async transaction => {
        await acquireRemoteRelationAdmissionTransactionLock(transaction, principal.tenantId, principal.shareId);
        const state = await requireShareState(transaction, principal);
        await requireActiveProject(transaction, principal, input.project);
        requireFreshAttestationPolicy(principal, state, attestation, input.project);
        const existing = await transaction<StoredRemoteMemoryProposalRow[]>`
          SELECT * FROM remote_memory.durable_memory_proposals
          WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId}
            AND proposer_principal_id = ${principal.principalId} AND operation_id = ${input.operationId}
          FOR UPDATE
        `;
        if (existing[0]) {
          if (existing[0].request_hash !== requestHash) {
            throw remoteMemoryError('idempotency_mismatch', 'The proposal operation id was already used.');
          }
          return remoteMemoryProposalReceiptFromRow(existing[0]);
        }
        const proposalId = randomUuidV4();
        const revision = randomUuidV4();
        const expiresAt = new Date(now.getTime() + REMOTE_MEMORY_PROPOSAL_RETENTION_DAYS * 86_400_000);
        const inserted = await transaction<StoredRemoteMemoryProposalRow[]>`
          INSERT INTO remote_memory.durable_memory_proposals(
            tenant_id, share_id, id, revision, project, topic, proposer_principal_id, operation_id,
            request_hash, payload, status, workload_attestation_id, expires_at, created_at
          ) VALUES (
            ${principal.tenantId}, ${principal.shareId}, ${proposalId}, ${revision}, ${input.project}, ${input.topic},
            ${principal.principalId}, ${input.operationId}, ${requestHash},
            ${transaction.json(requireJsonValue(payload))}, 'pending', ${attestation?.attestationId ?? null},
            ${expiresAt.toISOString()}, ${now.toISOString()}
          ) ON CONFLICT (tenant_id, share_id, proposer_principal_id, operation_id) DO NOTHING
          RETURNING *
        `;
        const created =
          inserted[0] ??
          (
            await transaction<StoredRemoteMemoryProposalRow[]>`
              SELECT * FROM remote_memory.durable_memory_proposals
              WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId}
                AND proposer_principal_id = ${principal.principalId} AND operation_id = ${input.operationId}
              FOR UPDATE
            `
          )[0];
        if (!created) throw remoteMemoryError('service_unavailable', 'The durable memory proposal was not stored.');
        if (created.request_hash !== requestHash) {
          throw remoteMemoryError('idempotency_mismatch', 'The proposal operation id was already used.');
        }
        return remoteMemoryProposalReceiptFromRow(created);
      },
      execution,
    );
  }

  async listProposals(
    principal: AuthorizedRemotePrincipal,
    input: RemoteMemoryProposalListInputV1,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<{readonly entries: readonly RemoteMemoryProposalSummaryV1[]; readonly nextProposalId?: string}> {
    return listStoredRemoteMemoryProposals(principal, input, use =>
      this.withTenant(principal.tenantId, use, execution),
    );
  }

  async readProposal(
    principal: AuthorizedRemotePrincipal,
    proposalId: string,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<RemoteMemoryProposalV1> {
    return readStoredRemoteMemoryProposal(principal, proposalId, use =>
      this.withTenant(principal.tenantId, use, execution),
    );
  }

  async reviewProposal(
    principal: AuthorizedRemotePrincipal,
    input: RemoteMemoryProposalReviewInputV1,
    requestId: string,
    attestation?: CursorWorkloadAttestation,
    now = new Date(),
    execution?: RemoteMemoryRequestExecution,
  ): Promise<RemoteMemoryProposalV1> {
    assertGitMemoryBinding(this.gitStore?.binding, principal);
    const claimed = await claimStoredRemoteMemoryProposalReview({
      ...(attestation ? {attestationId: attestation.attestationId} : {}),
      beforeRead: transaction =>
        acquireRemoteRelationAdmissionTransactionLock(transaction, principal.tenantId, principal.shareId),
      now,
      principal,
      review: input,
      validate: async (transaction, proposal) => {
        const state = await requireShareState(transaction, principal);
        await requireActiveProject(transaction, principal, proposal.project);
        requireFreshAttestationPolicy(principal, state, attestation, proposal.project);
      },
      withTenant: use => this.withTenant(principal.tenantId, use, execution),
    });
    if (claimed.kind === 'replay') return claimed.proposal;
    if (claimed.kind === 'decided') return claimed.proposal;
    if (claimed.kind === 'expired') {
      throw remoteMemoryError('conflict', 'The durable memory proposal expired.', {reason: 'proposal_expired'});
    }
    if (
      claimed.row.payload === null ||
      claimed.row.approval_revision_id === null ||
      claimed.row.approval_source_agent_client === null ||
      claimed.row.decision_claimed_at === null
    ) {
      throw remoteMemoryError('service_unavailable', 'The durable memory proposal approval plan is unavailable.');
    }
    const payload = durableProposalPayloadFromUnknown(claimed.row.payload);
    try {
      await this.remember(
        principal,
        durableProposalRememberInput(payload, durableProposalApprovalOperationId(claimed.row)),
        requestId,
        attestation,
        claimed.row.created_at,
        execution,
        {proposal: claimed.row, review: claimed.review, reviewedAt: now},
      );
      return this.readProposal(principal, claimed.row.id, execution);
    } catch (cause) {
      if (Schema.is(RemoteMemoryError)(cause) && (cause.code === 'conflict' || cause.code === 'invalid_request')) {
        await this.finishProposalDecision(
          principal,
          claimed.row,
          claimed.review,
          'conflict',
          undefined,
          attestation,
          now,
          execution,
        );
      }
      throw cause;
    }
  }

  async read(
    principal: AuthorizedRemotePrincipal,
    input: RemoteReadInputV1,
    requestId: string,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<RemoteMemoryReadResult> {
    assertGitMemoryBinding(this.gitStore?.binding, principal);
    const loaded = await this.withTenant(
      principal.tenantId,
      async transaction => {
        const state = await requireShareState(transaction, principal);
        const canonicalUri = await resolveCanonicalUri(transaction, principal, input.uri);
        const project = parseRemoteShareAddress(canonicalUri).project;
        requirePrincipalProject(principal, project);
        await requireActiveProject(transaction, principal, project);
        const rows = input.revision
          ? await transaction<HeadRow[]>`
            SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic, r.id AS current_revision_id,
              r.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path, h.retention_class, h.expires_at,
              h.created_at, r.created_at AS updated_at
            FROM remote_memory.memory_heads h
            JOIN remote_memory.memory_revisions r
              ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.head_id = h.id
            WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
              AND h.canonical_uri = ${canonicalUri} AND r.id = ${input.revision}
          `
          : await transaction<HeadRow[]>`
            SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic, h.current_revision_id,
              h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path, h.retention_class, h.expires_at,
              h.created_at, h.updated_at
            FROM remote_memory.memory_heads h
            JOIN remote_memory.memory_revisions r
              ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
            WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
              AND h.canonical_uri = ${canonicalUri}
          `;
        const head = rows[0];
        if (!head) throw remoteMemoryError('not_found', 'The remote memory was not found.');
        return {head, state};
      },
      execution,
    );
    return {
      content: await this.revisionBody(loaded.head),
      kind: loaded.head.kind,
      project: loaded.head.project,
      receipt: receipt(principal, loaded.state, requestId, {
        revision: loaded.head.current_revision_id,
        uri: loaded.head.canonical_uri,
      }),
      status: loaded.head.status,
      topic: loaded.head.topic,
      uri: loaded.head.canonical_uri,
    };
  }

  async list(
    principal: AuthorizedRemotePrincipal,
    input: {
      readonly afterUri?: string;
      readonly kinds?: readonly ('durable' | 'handoff')[];
      readonly limit: number;
      readonly project?: string;
      readonly status?: 'active' | 'archived' | 'expired' | 'superseded';
    },
    requestId: string,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<{
    readonly entries: readonly RemoteMemoryListEntry[];
    readonly nextCursor?: string;
    readonly receipt: RemoteMemoryReceiptV1;
  }> {
    assertGitMemoryBinding(this.gitStore?.binding, principal);
    return this.withTenant(
      principal.tenantId,
      async transaction => {
        const state = await requireShareState(transaction, principal);
        const kinds = input.kinds ?? ['durable', 'handoff'];
        const allowedProjects = principal.allowedProjects === 'all' ? null : [...principal.allowedProjects];
        const rows = await transaction<HeadRow[]>`
        SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic, h.current_revision_id,
          h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path, h.retention_class, h.expires_at,
          h.created_at, h.updated_at
        FROM remote_memory.memory_heads h
        JOIN remote_memory.projects p
          ON p.tenant_id = h.tenant_id AND p.share_id = h.share_id AND p.name = h.project AND p.status = 'active'
        JOIN remote_memory.memory_revisions r
          ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
        WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
          AND h.kind = ANY(${transaction.array([...kinds])})
          AND (${allowedProjects ? transaction.array(allowedProjects) : null}::text[] IS NULL
            OR h.project = ANY(${allowedProjects ? transaction.array(allowedProjects) : null}))
          AND (${input.project ?? null}::text IS NULL OR h.project = ${input.project ?? null})
          AND (${input.status ?? null}::text IS NULL OR h.status = ${input.status ?? null})
          AND h.canonical_uri > ${input.afterUri ?? ''}
        ORDER BY h.canonical_uri
        LIMIT ${input.limit + 1}
      `;
        const page = rows.slice(0, input.limit);
        return {
          entries: EffectArray.map(page, head => ({
            kind: head.kind,
            modifiedAt: head.updated_at.toISOString(),
            project: head.project,
            revision: head.current_revision_id,
            status: head.status,
            topic: head.topic,
            uri: head.canonical_uri,
          })),
          ...(rows.length > input.limit && page.at(-1) ? {nextCursor: page.at(-1)!.canonical_uri} : {}),
          receipt: receipt(principal, state, requestId),
        };
      },
      execution,
    );
  }

  async recall(
    principal: AuthorizedRemotePrincipal,
    input: RemoteRecallInputV1,
    requestId: string,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<{readonly receipt: RemoteMemoryReceiptV1; readonly results: readonly RemoteMemoryRecallResult[]}> {
    assertGitMemoryBinding(this.gitStore?.binding, principal);
    requirePrincipalProject(principal, input.project);
    const loaded = await this.withTenant(
      principal.tenantId,
      async transaction => {
        const authorizedState = await requireShareState(transaction, principal);
        await requireActiveProject(transaction, principal, input.project);
        const kinds = input.kinds ?? ['durable', 'handoff'];
        const limit = input.limit ?? 10;
        const rows = await transaction<RecallRow[]>`
        WITH share_state AS (
          SELECT indexed_generation FROM remote_memory.shares
          WHERE tenant_id = ${principal.tenantId} AND id = ${principal.shareId} AND status = 'active'
        ), query AS (
          SELECT plainto_tsquery('simple', ${input.query}) AS value
        ), candidates AS (
          SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic,
            h.current_revision_id, h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path,
            h.retention_class, h.expires_at, h.created_at, h.updated_at,
            d.generation,
            ts_rank_cd(d.searchable, query.value) + CASE WHEN h.kind = 'handoff' THEN 0.02 ELSE 0 END AS score
          FROM remote_memory.search_documents d
          JOIN remote_memory.memory_heads h
            ON h.tenant_id = d.tenant_id AND h.share_id = d.share_id AND h.id = d.head_id
          JOIN remote_memory.memory_revisions r
            ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
          CROSS JOIN query
          WHERE d.tenant_id = ${principal.tenantId} AND d.share_id = ${principal.shareId}
            AND h.project = ${input.project} AND h.kind = ANY(${transaction.array([...kinds])})
            AND h.status = 'active' AND d.revision_id = h.current_revision_id
            AND d.searchable @@ query.value
          UNION ALL
          SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic,
            h.current_revision_id, h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path,
            h.retention_class, h.expires_at, h.created_at, h.updated_at,
            r.generation,
            ts_rank_cd(to_tsvector('simple', h.project || ' ' || h.topic || ' ' || r.markdown_body), query.value)
              + CASE WHEN h.kind = 'handoff' THEN 0.02 ELSE 0 END + 0.01
          FROM remote_memory.memory_heads h
          JOIN remote_memory.memory_revisions r
            ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
          CROSS JOIN share_state
          CROSS JOIN query
          WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
            AND h.project = ${input.project} AND h.kind = ANY(${transaction.array([...kinds])})
            AND h.status = 'active' AND r.generation > share_state.indexed_generation
            AND to_tsvector('simple', h.project || ' ' || h.topic || ' ' || r.markdown_body) @@ query.value
        )
        SELECT DISTINCT ON (canonical_uri) * FROM (
          SELECT * FROM candidates
          ORDER BY score DESC, generation DESC
          LIMIT ${Math.min(limit * 8, 800)}
        ) bounded_candidates
        ORDER BY canonical_uri, generation DESC, score DESC
      `;
        const ranked = rows.sort(
          (left, right) =>
            numeric(right.score) - numeric(left.score) ||
            Effect.pipe(left.canonical_uri, EffectString.localeCompare(right.canonical_uri)),
        );
        return {authorizedState, limit, ranked};
      },
      execution,
    );
    const results: RemoteMemoryRecallResult[] = [];
    let hydrates = 0;
    for (const row of loaded.ranked) {
      if (results.length >= loaded.limit || hydrates >= loaded.limit) break;
      hydrates += 1;
      const body = await this.revisionBody(row);
      if (
        row.git_commit &&
        row.markdown_body === '' &&
        !remoteRecallTextMatches(`${row.project} ${row.topic} ${body}`, input.query)
      ) {
        continue;
      }
      results.push({
        excerpt: remoteMemoryExcerpt(body, input.query),
        kind: row.kind,
        project: row.project,
        revision: row.current_revision_id,
        score: numeric(row.score),
        status: row.status,
        topic: row.topic,
        uri: row.canonical_uri,
      });
    }
    return {
      receipt: receipt(principal, loaded.authorizedState, requestId, {
        overlayUsed:
          numeric(loaded.authorizedState.indexed_generation) < numeric(loaded.authorizedState.share_generation),
      }),
      results,
    };
  }

  async contextBrief(
    principal: AuthorizedRemotePrincipal,
    input: RemoteContextBriefInputV1,
    requestId: string,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<RemoteMemoryContextBriefResult> {
    assertGitMemoryBinding(this.gitStore?.binding, principal);
    requirePrincipalProject(principal, input.project);
    return compileRemoteContextBrief(principal, input, {
      gitStoreConfigured: this.gitStore !== undefined,
      makeReceipt: state => receipt(principal, state, requestId),
      recall: recallInput => this.recall(principal, recallInput, requestId, execution),
      revisionBody: head => this.revisionBody(head),
      withTenant: use => this.withTenant(principal.tenantId, use, execution),
    });
  }

  async remember(
    principal: AuthorizedRemotePrincipal,
    input: RemoteRememberInputV1,
    requestId: string,
    attestation?: CursorWorkloadAttestation,
    now = new Date(),
    execution?: RemoteMemoryRequestExecution,
    proposalApproval?: StoredProposalApprovalContext,
  ): Promise<RemoteMemoryReceiptV1> {
    assertGitMemoryBinding(this.gitStore?.binding, principal);
    requirePrincipalProject(principal, input.project);
    assertRemoteRememberReplacementTarget(principal, input);
    input = authorizeRemoteRememberRelations(principal, input);
    const authorityValidThrough = mutationAuthorityValidThrough(
      execution,
      this.gitStore ? GIT_REF_UPDATE_TIMEOUT_MILLISECONDS : 0,
    );
    const authoredRelations = input.relations;
    if (input.lifecycle?.expiresAt && Date.parse(input.lifecycle.expiresAt) <= now.getTime()) {
      throw remoteMemoryError('invalid_request', 'Remote memory expiry must be in the future.');
    }
    const logicalKey = formatRemoteMemoryLogicalKey({
      kind: input.kind,
      project: input.project,
      shareId: principal.shareId,
      tenantId: principal.tenantId,
      topic: input.topic,
      version: REMOTE_MEMORY_REVISION_VERSION,
    });
    const fingerprint = requestFingerprint(principal, input);
    const reservation = await this.reserveOperation(
      principal,
      input.operationId,
      fingerprint,
      requestId,
      now,
      execution,
      authoredRelations,
      proposalApproval !== undefined,
    );
    if (reservation.kind === 'replay') return reservation.receipt;
    let gitLanded = false;
    try {
      const planned = await this.withTenant(
        principal.tenantId,
        async transaction => {
          await requireShareState(transaction, principal);
          await requireActiveProject(transaction, principal, input.project);
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${logicalKey}, 0))`;
          const current = await this.loadTopicHead(transaction, principal, input.kind, input.project, input.topic);
          if (current?.kind === 'handoff' && current.status !== 'active') {
            throw remoteMemoryError(
              'conflict',
              'A terminal remote handoff cannot be revised; create a new logical handoff.',
              {
                currentRevision: current.current_revision_id,
                currentState: current.status,
                reason: 'terminal_state',
              },
            );
          }
          const share = await requireShareState(transaction, principal);
          requireFreshAttestationPolicy(principal, share, attestation, input.project, authorityValidThrough);
          const proposedRevision =
            reservation.publicationPlan?.proposedRevision ??
            proposalApproval?.proposal.approval_revision_id ??
            randomUuidV4();
          if (!proposalApproval || !current) {
            this.assertRememberDecision(principal, input, current, logicalKey, fingerprint, proposedRevision, share);
          }
          return {
            canonicalUri: formatRemoteMemoryUri({
              kind: input.kind,
              project: input.project,
              shareId: principal.shareId,
              topic: input.topic,
            }),
            current,
            proposedRevision,
            share,
          };
        },
        execution,
      );
      const priorBody = planned.current ? await this.revisionBody(planned.current) : undefined;
      const renderedAt = reservation.publicationPlan
        ? storedRememberPublicationPlanDate(reservation.publicationPlan)
        : now;
      const memoryId =
        reservation.publicationPlan?.memoryId ??
        (proposalApproval
          ? `tn_${Effect.pipe(proposalApproval.proposal.id, EffectString.replaceAll('-', ''))}`
          : `tn_${Effect.pipe(randomUuidV4(), EffectString.replaceAll('-', ''))}`);
      const sourceAgentClient =
        proposalApproval?.proposal.approval_source_agent_client ?? (attestation ? 'cursor' : 'remote');
      let document = makeRemoteDocument(
        input,
        planned.current !== undefined,
        planned.canonicalUri,
        sourceAgentClient,
        renderedAt,
        priorBody,
        memoryId,
      );
      const persistAndCommit = async (tenantTransaction?: TenantTransactionRunner) => {
        const withTenant: TenantTransactionRunner =
          tenantTransaction ?? ((tenantId, use, requestExecution) => this.withTenant(tenantId, use, requestExecution));
        let expectedSourceHashes: readonly {readonly path: string; readonly contentHash: string}[] | undefined;
        let stored:
          | {readonly gitCommit: string | null; readonly gitPath: string | null; readonly markdownBody: string}
          | undefined;
        if (reservation.publicationPlan && this.gitStore) {
          const recovered = await this.gitStore.readCurrentIfHash(
            gitCanonicalSharePath(input.kind, input.project, input.topic),
            reservation.publicationPlan.contentHash,
          );
          if (recovered) {
            document = {content: recovered.content, contentHash: recovered.contentHash};
            stored = {gitCommit: recovered.gitCommit, gitPath: recovered.gitPath, markdownBody: ''};
            gitLanded = true;
          }
        }
        if (!stored && (proposalApproval || authoredRelations?.length || input.citationSources !== undefined)) {
          await withTenant(
            principal.tenantId,
            async transaction => {
              const share = await requireShareState(transaction, principal);
              await requireActiveProject(transaction, principal, input.project);
              requireFreshAttestationPolicy(principal, share, attestation, input.project, authorityValidThrough);
              if (authoredRelations?.length) {
                await this.requireActiveRelationTargets(transaction, principal, authoredRelations);
              }
              if (input.citationSources !== undefined) {
                const resolved = await resolveRemoteCitationSources(
                  transaction,
                  principal,
                  input.citationSources,
                  this.gitStore,
                );
                expectedSourceHashes = resolved.expectedSourceHashes;
                document = makeRemoteDocument(
                  input,
                  planned.current !== undefined,
                  planned.canonicalUri,
                  sourceAgentClient,
                  renderedAt,
                  priorBody,
                  memoryId,
                  resolved.citations,
                );
              }
            },
            execution,
          );
        }
        if (proposalApproval && planned.current && planned.current.content_hash !== document.contentHash) {
          this.assertRememberDecision(
            principal,
            input,
            planned.current,
            logicalKey,
            fingerprint,
            planned.proposedRevision,
            planned.share,
          );
        }
        if (!stored) {
          const prepared = await withTenant(
            principal.tenantId,
            transaction =>
              recordRememberPublicationPlan(transaction, principal, input.operationId, fingerprint, {
                contentHash: document.contentHash,
                kind: 'remember_publication_plan',
                memoryId,
                proposedRevision: planned.proposedRevision,
                renderedAt: renderedAt.toISOString(),
                version: 1,
              }),
            execution,
          );
          if (prepared.kind === 'outcome') {
            const replay = readStoredOperationOutcome(prepared.outcome, requestId);
            if (Schema.is(RemoteMemoryError)(replay)) throw replay;
            return replay;
          }
          stored = await this.persistCanonicalBody({
            authorizeRefUpdate: requiredValidityMilliseconds =>
              this.requireCurrentMutationAuthority(
                principal,
                attestation,
                input.project,
                requiredValidityMilliseconds,
                execution,
                withTenant,
              ),
            expectedSourceHashes,
            current: planned.current,
            document,
            kind: input.kind,
            message: `remember ${input.kind} ${input.project}/${input.topic}`,
            project: input.project,
            topic: input.topic,
          });
          gitLanded = stored.gitCommit !== null;
        }
        try {
          return await this.commitRememberRevision({
            attestation,
            authorityValidThrough,
            canonicalUri: planned.canonicalUri,
            document,
            execution,
            expectedRevision: planned.current?.current_revision_id,
            fingerprint,
            input,
            logicalKey,
            now: renderedAt,
            principal,
            proposedRevision: planned.proposedRevision,
            proposalApproval,
            requestId,
            stored,
            withTenant,
          });
        } catch (phase3) {
          if (!gitLanded) throw phase3;
          return await this.commitRememberRevision({
            attestation,
            authorityValidThrough,
            canonicalUri: planned.canonicalUri,
            document,
            execution,
            expectedRevision: planned.current?.current_revision_id,
            fingerprint,
            input,
            logicalKey,
            now: renderedAt,
            principal,
            proposedRevision: planned.proposedRevision,
            proposalApproval,
            recoverGit: true,
            requestId,
            stored,
            withTenant,
          });
        }
      };
      return await this.withRelationAdmissionFence(principal, execution, persistAndCommit);
    } catch (cause) {
      const conflictAfterGit = gitLanded && Schema.is(RemoteMemoryError)(cause) && cause.code === 'conflict';
      if ((!gitLanded && !proposalApproval) || conflictAfterGit) {
        await this.retainRejectedOperation(principal, input.operationId, fingerprint, cause, execution);
      }
      throw cause;
    }
  }

  async transitionHandoff(
    principal: AuthorizedRemotePrincipal,
    input: RemoteHandoffTransitionInput,
    requestId: string,
    attestation?: CursorWorkloadAttestation,
    now = new Date(),
    execution?: RemoteMemoryRequestExecution,
  ): Promise<RemoteMemoryReceiptV1> {
    assertGitMemoryBinding(this.gitStore?.binding, principal);
    const address = parseRemoteShareAddress(input.uri);
    if (address.shareId !== principal.shareId || address.kind !== 'handoff') {
      throw remoteMemoryError('forbidden', 'The handoff URI is outside the authorized share.');
    }
    requirePrincipalProject(principal, address.project);
    const authorityValidThrough = mutationAuthorityValidThrough(
      execution,
      this.gitStore ? GIT_REF_UPDATE_TIMEOUT_MILLISECONDS : 0,
    );
    const fingerprint = lifecycleRequestFingerprint(principal, input);
    const reservation = await this.reserveOperation(
      principal,
      input.operationId,
      fingerprint,
      requestId,
      now,
      execution,
    );
    if (reservation.kind === 'replay') return reservation.receipt;
    const logicalKey = formatRemoteMemoryLogicalKey({
      kind: 'handoff',
      project: address.project,
      shareId: principal.shareId,
      tenantId: principal.tenantId,
      topic: address.topic,
      version: REMOTE_MEMORY_REVISION_VERSION,
    });
    let gitLanded = false;
    try {
      const planned = await this.withTenant(
        principal.tenantId,
        async transaction => {
          await requireShareState(transaction, principal);
          await requireActiveProject(transaction, principal, address.project);
          await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${logicalKey}, 0))`;
          const current = await this.loadHeadByUri(transaction, principal, address.canonicalUri, 'handoff');
          if (!current) throw remoteMemoryError('not_found', 'The remote handoff was not found.');
          if (current.current_revision_id !== input.baseRevision) {
            throw remoteMemoryError('conflict', 'The remote handoff changed; re-read it before changing lifecycle.', {
              currentRevision: current.current_revision_id,
              reason: 'stale_base',
            });
          }
          const lifecycle = transitionRemoteHandoffLifecycle(current.status, input.operation);
          if (lifecycle.kind === 'rejected') {
            throw remoteMemoryError('conflict', 'The remote handoff lifecycle transition is not allowed.', {
              currentState: lifecycle.from,
              reason: lifecycle.reason,
            });
          }
          const proposedRevision = randomUuidV4();
          const share = await requireShareState(transaction, principal);
          requireFreshAttestationPolicy(principal, share, attestation, address.project, authorityValidThrough);
          const decision = planRemoteMutation({
            currentShareGeneration: numeric(share.share_generation),
            head: {
              logicalKey,
              revision: current.current_revision_id,
              status: current.status,
              version: REMOTE_MEMORY_REVISION_VERSION,
            },
            intent: {
              baseRevision: input.baseRevision,
              fingerprint,
              idempotencyKey: {
                operationId: input.operationId,
                principalId: principal.principalId,
                tenantId: principal.tenantId,
                version: REMOTE_MEMORY_REVISION_VERSION,
              },
              logicalKey,
              proposedRevision,
              version: REMOTE_MEMORY_REVISION_VERSION,
            },
          });
          if (decision.kind !== 'commit') {
            throw remoteMemoryError('conflict', 'The remote handoff lifecycle transition conflicted.');
          }
          return {current, proposedRevision, status: lifecycle.to};
        },
        execution,
      );
      const document = makeLifecycleDocument(
        planned.current,
        planned.status,
        now,
        await this.revisionBody(planned.current),
      );
      const stored = await this.persistCanonicalBody({
        authorizeRefUpdate: requiredValidityMilliseconds =>
          this.requireCurrentMutationAuthority(
            principal,
            attestation,
            address.project,
            requiredValidityMilliseconds,
            execution,
          ),
        current: planned.current,
        document,
        kind: 'handoff',
        message: `handoff ${input.operation} ${address.project}/${address.topic}`,
        project: address.project,
        topic: address.topic,
      });
      gitLanded = stored.gitCommit !== null;
      try {
        return await this.commitHandoffRevision({
          address,
          attestation,
          authorityValidThrough,
          document,
          execution,
          fingerprint,
          input,
          logicalKey,
          now,
          planned,
          principal,
          requestId,
          stored,
        });
      } catch (phase3) {
        if (!gitLanded) throw phase3;
        return await this.commitHandoffRevision({
          address,
          attestation,
          authorityValidThrough,
          document,
          execution,
          fingerprint,
          input,
          logicalKey,
          now,
          planned,
          principal,
          requestId,
          stored,
        });
      }
    } catch (cause) {
      const conflictAfterGit = gitLanded && Schema.is(RemoteMemoryError)(cause) && cause.code === 'conflict';
      if (!gitLanded || conflictAfterGit) {
        await this.retainRejectedOperation(principal, input.operationId, fingerprint, cause, execution);
      }
      throw cause;
    }
  }

  async ingestActiveGitShares(
    requestId: string,
    now = new Date(),
  ): Promise<{readonly ingested: number; readonly skipped: number}> {
    if (!this.gitStore) {
      throw remoteMemoryError('invalid_request', 'Git share ingest requires a git canonical store.');
    }
    const binding = requireGitMemoryBinding(this.gitStore.binding);
    const shares = await this.sql<{readonly share_id: string; readonly tenant_id: string}[]>`
      SELECT tenant_id, share_id FROM remote_memory.share_directory
      WHERE status = 'active'
        AND tenant_id = ${binding.tenantId}
        AND share_id = ${binding.shareId}
      ORDER BY tenant_id, share_id
    `;
    let ingested = 0;
    let skipped = 0;
    for (const share of shares) {
      const principal = await this.loadGitIngestPrincipal(share.tenant_id, share.share_id);
      if (!principal) {
        throw remoteMemoryError(
          'service_unavailable',
          'The Git ingest service identity is unavailable; check operator provisioning and revocation.',
          {
            reason: 'git_ingest_identity_unavailable',
          },
        );
      }
      const result = await this.ingestGitShare(principal, `${requestId}:${share.share_id}`, now);
      ingested += result.ingested;
      skipped += result.skipped;
    }
    return {ingested, skipped};
  }

  async ingestGitShare(
    principal: AuthorizedRemotePrincipal,
    requestId: string,
    now = new Date(),
  ): Promise<{readonly ingested: number; readonly skipped: number}> {
    assertGitMemoryBinding(this.gitStore?.binding, principal);
    if (!this.gitStore) throw remoteMemoryError('invalid_request', 'Git share ingest requires a git canonical store.');
    const result = await ingestGitShare({
      gitStore: this.gitStore,
      principal,
      requestId,
      now,
      withTenant: use => this.withTenant(principal.tenantId, use),
    });
    return result;
  }

  private async revisionBody(head: Pick<HeadRow, 'git_commit' | 'git_path' | 'markdown_body'>): Promise<string> {
    if (head.git_commit && head.git_path) {
      if (!this.gitStore) {
        throw remoteMemoryError('service_unavailable', 'The git-canonical memory store is not configured.');
      }
      return this.gitStore.read({commit: head.git_commit, path: head.git_path});
    }
    return head.markdown_body;
  }

  private async persistCanonicalBody(input: {
    readonly authorizeRefUpdate?: (requiredValidityMilliseconds: number) => Promise<void>;
    readonly current?: HeadRow;
    readonly document: {readonly content: string; readonly contentHash: string};
    readonly expectedSourceHashes?: readonly {readonly path: string; readonly contentHash: string}[];
    readonly kind: 'durable' | 'handoff';
    readonly message: string;
    readonly project: string;
    readonly topic: string;
  }): Promise<{readonly gitCommit: string | null; readonly gitPath: string | null; readonly markdownBody: string}> {
    if (!this.gitStore) {
      return {gitCommit: null, gitPath: null, markdownBody: input.document.content};
    }
    const committed = await this.gitStore.commit({
      ...(input.authorizeRefUpdate === undefined ? {} : {authorizeRefUpdate: input.authorizeRefUpdate}),
      content: input.document.content,
      ...(input.expectedSourceHashes === undefined ? {} : {expectedSourceHashes: input.expectedSourceHashes}),
      ...(input.current ? {expectedContentHash: input.current.content_hash} : {}),
      message: input.message,
      path: gitCanonicalSharePath(input.kind, input.project, input.topic),
    });
    return {gitCommit: committed.gitCommit, gitPath: committed.gitPath, markdownBody: ''};
  }

  private async loadTopicHead(
    transaction: ISql,
    principal: AuthorizedRemotePrincipal,
    kind: 'durable' | 'handoff',
    project: string,
    topic: string,
  ): Promise<HeadRow | undefined> {
    const rows = await transaction<HeadRow[]>`
      SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic, h.current_revision_id,
        h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path, h.retention_class, h.expires_at,
        h.created_at, h.updated_at
      FROM remote_memory.memory_heads h
      JOIN remote_memory.memory_revisions r
        ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
      WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
        AND h.kind = ${kind} AND h.project = ${project} AND h.topic = ${topic}
      FOR UPDATE OF h
    `;
    return rows[0];
  }

  private async loadHeadByUri(
    transaction: ISql,
    principal: AuthorizedRemotePrincipal,
    canonicalUri: string,
    kind: 'durable' | 'handoff',
  ): Promise<HeadRow | undefined> {
    const rows = await transaction<HeadRow[]>`
      SELECT h.canonical_uri, h.id AS head_id, h.kind, h.project, h.topic, h.current_revision_id,
        h.status, r.markdown_body, r.content_hash, r.git_commit, r.git_path, h.retention_class, h.expires_at,
        h.created_at, h.updated_at
      FROM remote_memory.memory_heads h
      JOIN remote_memory.memory_revisions r
        ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
      WHERE h.tenant_id = ${principal.tenantId} AND h.share_id = ${principal.shareId}
        AND h.canonical_uri = ${canonicalUri} AND h.kind = ${kind}
      FOR UPDATE OF h
    `;
    return rows[0];
  }

  private async requireActiveRelationTargets(
    transaction: ISql,
    principal: AuthorizedRemotePrincipal,
    relations: readonly MemoryRelation[] | undefined,
  ): Promise<void> {
    if (!relations?.length) return;
    const targetUris = [...new Set(EffectArray.map(relations, relation => relation.uri))];
    const addresses = EffectArray.map(targetUris, uri => parseRemoteShareAddress(uri));
    const projects = [...new Set(EffectArray.map(addresses, address => address.project))];
    await requireShareState(transaction, principal);
    for (const project of projects) requirePrincipalProject(principal, project);
    const activeProjects = await transaction<{name: string}[]>`
      SELECT name FROM remote_memory.projects
      WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId}
        AND name = ANY(${transaction.array(projects)}) AND status = 'active'
    `;
    if (new Set(EffectArray.map(activeProjects, project => project.name)).size !== projects.length) {
      throw remoteMemoryError('forbidden', 'A relation target project is not active in the authorized memory share.');
    }
    const rows = await transaction<{canonical_uri: string}[]>`
      SELECT canonical_uri FROM remote_memory.memory_heads
      WHERE tenant_id = ${principal.tenantId} AND share_id = ${principal.shareId}
        AND canonical_uri = ANY(${transaction.array(targetUris)}) AND status = 'active'
    `;
    if (new Set(EffectArray.map(rows, row => row.canonical_uri)).size !== targetUris.length) {
      throw remoteMemoryError('invalid_request', 'Relation targets must resolve to active remote memories.');
    }
  }

  private assertRememberDecision(
    principal: AuthorizedRemotePrincipal,
    input: RemoteRememberInputV1,
    current: HeadRow | undefined,
    logicalKey: string,
    fingerprint: string,
    proposedRevision: string,
    share: ShareStateRow,
  ): void {
    const intent: RemoteMutationIntentV1 = {
      ...(input.baseRevision ? {baseRevision: input.baseRevision} : {}),
      fingerprint,
      idempotencyKey: {
        operationId: input.operationId,
        principalId: principal.principalId,
        tenantId: principal.tenantId,
        version: REMOTE_MEMORY_REVISION_VERSION,
      },
      logicalKey,
      proposedRevision,
      version: REMOTE_MEMORY_REVISION_VERSION,
    };
    const head: RemoteMemoryHeadV1 | undefined = current
      ? {
          logicalKey,
          revision: current.current_revision_id,
          status: current.status,
          version: REMOTE_MEMORY_REVISION_VERSION,
        }
      : undefined;
    const decision = planRemoteMutation({
      currentShareGeneration: numeric(share.share_generation),
      head,
      intent,
    });
    if (decision.kind === 'conflict') {
      throw remoteMemoryError(
        'conflict',
        'The remote memory changed; re-read it and retry with its current revision.',
        {
          ...(decision.currentRevision ? {currentRevision: decision.currentRevision} : {}),
          reason: decision.reason,
          shareGeneration: decision.shareGeneration,
        },
      );
    }
    if (decision.kind !== 'commit') {
      throw remoteMemoryError('service_unavailable', 'The remote mutation could not be planned.');
    }
  }

  private async commitRememberRevision(input: {
    readonly attestation?: CursorWorkloadAttestation;
    readonly authorityValidThrough: number;
    readonly canonicalUri: string;
    readonly document: {readonly content: string; readonly contentHash: string};
    readonly execution?: RemoteMemoryRequestExecution;
    readonly expectedRevision?: string;
    readonly fingerprint: string;
    readonly input: RemoteRememberInputV1;
    readonly logicalKey: string;
    readonly now: Date;
    readonly principal: AuthorizedRemotePrincipal;
    readonly proposedRevision: string;
    readonly proposalApproval?: StoredProposalApprovalContext;
    readonly recoverGit?: boolean;
    readonly requestId: string;
    readonly stored: {
      readonly gitCommit: string | null;
      readonly gitPath: string | null;
      readonly markdownBody: string;
    };
    readonly withTenant?: TenantTransactionRunner;
  }): Promise<RemoteMemoryReceiptV1> {
    const withTenant: TenantTransactionRunner =
      input.withTenant ?? ((tenantId, use, execution) => this.withTenant(tenantId, use, execution));
    return withTenant(
      input.principal.tenantId,
      async transaction => {
        if (input.proposalApproval) {
          await acquireRemoteRelationAdmissionTransactionLock(
            transaction,
            input.principal.tenantId,
            input.principal.shareId,
          );
          await requireShareState(transaction, input.principal);
          await requireActiveProject(transaction, input.principal, input.input.project);
        } else {
          await requireShareState(transaction, input.principal);
          await requireActiveProject(transaction, input.principal, input.input.project);
        }
        await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.logicalKey}, 0))`;
        const current = await this.loadTopicHead(
          transaction,
          input.principal,
          input.input.kind,
          input.input.project,
          input.input.topic,
        );
        if (current?.content_hash === input.document.contentHash) {
          return this.recordExistingRememberOutcome(transaction, input, current);
        }
        if (input.recoverGit && input.stored.gitCommit && current?.git_commit === input.stored.gitCommit) {
          return this.recordExistingRememberOutcome(transaction, input, current);
        }
        if (current && current.current_revision_id !== input.expectedRevision) {
          throw remoteMemoryError(
            'conflict',
            'The remote memory changed; re-read it and retry with its current revision.',
            {
              currentRevision: current.current_revision_id,
              reason: 'stale_base',
            },
          );
        }
        const share = await requireShareState(transaction, input.principal);
        requireFreshAttestationPolicy(
          input.principal,
          share,
          input.attestation,
          input.input.project,
          input.authorityValidThrough,
        );
        const headId = current?.head_id ?? randomUuidV4();
        if (!current) {
          await transaction`
            INSERT INTO remote_memory.memory_heads(
              tenant_id, share_id, id, kind, project, topic, canonical_uri, status,
              retention_class, expires_at
            ) VALUES (
              ${input.principal.tenantId}, ${input.principal.shareId}, ${headId}, ${input.input.kind},
              ${input.input.project}, ${input.input.topic}, ${input.canonicalUri}, 'active',
              ${input.input.lifecycle?.retentionClass ?? null}, ${input.input.lifecycle?.expiresAt ?? null}
            )
          `;
        }
        return this.finishRememberRevision(transaction, input, current, headId, 'active');
      },
      input.execution,
    );
  }

  private async recordExistingRememberOutcome(
    transaction: ISql,
    input: {
      readonly attestation?: CursorWorkloadAttestation;
      readonly canonicalUri: string;
      readonly fingerprint: string;
      readonly input: RemoteRememberInputV1;
      readonly principal: AuthorizedRemotePrincipal;
      readonly proposalApproval?: StoredProposalApprovalContext;
      readonly requestId: string;
    },
    current: HeadRow,
  ): Promise<RemoteMemoryReceiptV1> {
    const committed = await requireShareState(transaction, input.principal);
    const result = receipt(input.principal, committed, input.requestId, {
      actor: mutationActor(input.principal, input.attestation),
      revision: current.current_revision_id,
      uri: input.canonicalUri,
    });
    await this.recordIdempotentOutcome(
      transaction,
      input.principal,
      input.input.operationId,
      input.fingerprint,
      result,
    );
    if (input.proposalApproval) {
      await finishStoredRemoteMemoryProposalDecisionInTransaction(
        transaction,
        input.principal,
        input.proposalApproval.proposal,
        input.proposalApproval.review,
        'approved',
        result,
        input.proposalApproval.reviewedAt,
      );
    }
    return result;
  }

  private async finishRememberRevision(
    transaction: ISql,
    input: {
      readonly attestation?: CursorWorkloadAttestation;
      readonly authorityValidThrough: number;
      readonly canonicalUri: string;
      readonly document: {readonly content: string; readonly contentHash: string};
      readonly fingerprint: string;
      readonly input: RemoteRememberInputV1;
      readonly now: Date;
      readonly principal: AuthorizedRemotePrincipal;
      readonly proposedRevision: string;
      readonly proposalApproval?: StoredProposalApprovalContext;
      readonly requestId: string;
      readonly stored: {
        readonly gitCommit: string | null;
        readonly gitPath: string | null;
        readonly markdownBody: string;
      };
    },
    current: HeadRow | undefined,
    headId: string,
    status: HeadRow['status'],
  ): Promise<RemoteMemoryReceiptV1> {
    const generationRows = await transaction<ShareStateRow[]>`
      UPDATE remote_memory.shares SET share_generation = share_generation + 1
      WHERE tenant_id = ${input.principal.tenantId} AND id = ${input.principal.shareId} AND status = 'active'
        AND policy_version = ${input.principal.sharePolicyVersion}
        AND policy_digest = ${input.principal.sharePolicyDigest}
      RETURNING share_generation, indexed_generation, policy_version, policy_digest
    `;
    const committedGeneration = generationRows[0];
    if (!committedGeneration) throw remoteMemoryError('forbidden', 'The memory share is no longer active.');
    const committed = await requireShareState(transaction, input.principal);
    if (numeric(committed.share_generation) !== numeric(committedGeneration.share_generation)) {
      throw remoteMemoryError('service_unavailable', 'The committed memory generation could not be verified.');
    }
    requireFreshAttestationPolicy(
      input.principal,
      committed,
      input.attestation,
      input.input.project,
      input.authorityValidThrough,
    );
    await transaction`
      INSERT INTO remote_memory.memory_revisions(
        tenant_id, share_id, id, head_id, base_revision_id, generation, status,
        markdown_body, content_hash, git_commit, git_path, oauth_principal_id, workload_attestation_id, operation_id
      ) VALUES (
        ${input.principal.tenantId}, ${input.principal.shareId}, ${input.proposedRevision}, ${headId},
        ${input.input.baseRevision ?? current?.current_revision_id ?? null}, ${numeric(committed.share_generation)},
        ${status}, ${input.stored.markdownBody}, ${input.document.contentHash}, ${input.stored.gitCommit},
        ${input.stored.gitPath}, ${input.principal.principalId}, ${input.attestation?.attestationId ?? null},
        ${input.input.operationId}
      )
    `;
    const parsed = parseMemoryDocument(input.canonicalUri, input.document.content);
    if (!parsed) throw remoteMemoryError('service_unavailable', 'The rendered remote memory document is invalid.');
    await replaceRemoteCodeLinkBacklinks(transaction, {
      citations: parsed.metadata.codeCitations ?? [],
      headId,
      revisionId: input.proposedRevision,
      shareId: input.principal.shareId,
      tenantId: input.principal.tenantId,
    });
    await transaction`
      UPDATE remote_memory.memory_heads SET
        current_revision_id = ${input.proposedRevision}, status = ${status},
        retention_class = ${input.input.lifecycle?.retentionClass ?? current?.retention_class ?? null},
        expires_at = ${input.input.lifecycle?.expiresAt ?? current?.expires_at?.toISOString() ?? null},
        updated_at = ${input.now.toISOString()}
      WHERE tenant_id = ${input.principal.tenantId} AND share_id = ${input.principal.shareId} AND id = ${headId}
    `;
    const result = receipt(input.principal, committed, input.requestId, {
      actor: mutationActor(input.principal, input.attestation),
      revision: input.proposedRevision,
      uri: input.canonicalUri,
    });
    await transaction`
      INSERT INTO remote_memory.outbox_events(
        tenant_id, share_id, id, generation, event_type, aggregate_id
      ) VALUES (
        ${input.principal.tenantId}, ${input.principal.shareId}, ${randomUuidV4()},
        ${numeric(committed.share_generation)}, 'memory_head_changed', ${headId}
      )
    `;
    await transaction`
      INSERT INTO remote_memory.audit_events(
        tenant_id, share_id, id, request_id, principal_id, workload_attestation_id,
        operation, result, policy_version, share_policy_version, generation
      ) VALUES (
        ${input.principal.tenantId}, ${input.principal.shareId}, ${randomUuidV4()}, ${input.requestId},
        ${input.principal.principalId}, ${input.attestation?.attestationId ?? null}, 'remember_context', 'committed',
        ${input.principal.policyVersion}, ${committed.policy_version}, ${numeric(committed.share_generation)}
      )
    `;
    await this.recordIdempotentOutcome(
      transaction,
      input.principal,
      input.input.operationId,
      input.fingerprint,
      result,
    );
    if (input.proposalApproval) {
      await finishStoredRemoteMemoryProposalDecisionInTransaction(
        transaction,
        input.principal,
        input.proposalApproval.proposal,
        input.proposalApproval.review,
        'approved',
        result,
        input.proposalApproval.reviewedAt,
      );
    }
    return result;
  }

  private async commitHandoffRevision(input: {
    readonly address: {readonly project: string; readonly topic: string};
    readonly attestation?: CursorWorkloadAttestation;
    readonly authorityValidThrough: number;
    readonly document: {readonly content: string; readonly contentHash: string};
    readonly execution?: RemoteMemoryRequestExecution;
    readonly fingerprint: string;
    readonly input: RemoteHandoffTransitionInput;
    readonly logicalKey: string;
    readonly now: Date;
    readonly planned: {
      readonly current: HeadRow;
      readonly proposedRevision: string;
      readonly status: HeadRow['status'];
    };
    readonly principal: AuthorizedRemotePrincipal;
    readonly requestId: string;
    readonly stored: {
      readonly gitCommit: string | null;
      readonly gitPath: string | null;
      readonly markdownBody: string;
    };
  }): Promise<RemoteMemoryReceiptV1> {
    return this.withTenant(
      input.principal.tenantId,
      async transaction => {
        await acquireRemoteRelationAdmissionTransactionLock(
          transaction,
          input.principal.tenantId,
          input.principal.shareId,
        );
        await requireShareState(transaction, input.principal);
        await requireActiveProject(transaction, input.principal, input.address.project);
        await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.logicalKey}, 0))`;
        const current = await this.loadHeadByUri(
          transaction,
          input.principal,
          input.planned.current.canonical_uri,
          'handoff',
        );
        if (!current) throw remoteMemoryError('not_found', 'The remote handoff was not found.');
        if (current.content_hash === input.document.contentHash && current.status === input.planned.status) {
          const committed = await requireShareState(transaction, input.principal);
          const result = receipt(input.principal, committed, input.requestId, {
            actor: mutationActor(input.principal, input.attestation),
            revision: current.current_revision_id,
            uri: current.canonical_uri,
          });
          await this.recordIdempotentOutcome(
            transaction,
            input.principal,
            input.input.operationId,
            input.fingerprint,
            result,
          );
          return result;
        }
        if (current.current_revision_id !== input.input.baseRevision) {
          throw remoteMemoryError('conflict', 'The remote handoff changed; re-read it before changing lifecycle.', {
            currentRevision: current.current_revision_id,
            reason: 'stale_base',
          });
        }
        const generationRows = await transaction<ShareStateRow[]>`
          UPDATE remote_memory.shares SET share_generation = share_generation + 1
          WHERE tenant_id = ${input.principal.tenantId} AND id = ${input.principal.shareId} AND status = 'active'
            AND policy_version = ${input.principal.sharePolicyVersion}
            AND policy_digest = ${input.principal.sharePolicyDigest}
          RETURNING share_generation, indexed_generation, policy_version, policy_digest
        `;
        const committedGeneration = generationRows[0];
        if (!committedGeneration) throw remoteMemoryError('forbidden', 'The memory share is no longer active.');
        const committed = await requireShareState(transaction, input.principal);
        if (numeric(committed.share_generation) !== numeric(committedGeneration.share_generation)) {
          throw remoteMemoryError('service_unavailable', 'The committed memory generation could not be verified.');
        }
        requireFreshAttestationPolicy(
          input.principal,
          committed,
          input.attestation,
          input.address.project,
          input.authorityValidThrough,
        );
        await transaction`
          INSERT INTO remote_memory.memory_revisions(
            tenant_id, share_id, id, head_id, base_revision_id, generation, status,
            markdown_body, content_hash, git_commit, git_path, oauth_principal_id, workload_attestation_id, operation_id
          ) VALUES (
            ${input.principal.tenantId}, ${input.principal.shareId}, ${input.planned.proposedRevision}, ${current.head_id},
            ${input.input.baseRevision}, ${numeric(committed.share_generation)}, ${input.planned.status},
            ${input.stored.markdownBody}, ${input.document.contentHash}, ${input.stored.gitCommit}, ${input.stored.gitPath},
            ${input.principal.principalId}, ${input.attestation?.attestationId ?? null}, ${input.input.operationId}
          )
        `;
        const parsed = parseMemoryDocument(current.canonical_uri, input.document.content);
        if (!parsed) throw remoteMemoryError('service_unavailable', 'The rendered remote handoff document is invalid.');
        await replaceRemoteCodeLinkBacklinks(transaction, {
          citations: parsed.metadata.codeCitations ?? [],
          headId: current.head_id,
          revisionId: input.planned.proposedRevision,
          shareId: input.principal.shareId,
          tenantId: input.principal.tenantId,
        });
        await transaction`
          UPDATE remote_memory.memory_heads
          SET current_revision_id = ${input.planned.proposedRevision}, status = ${input.planned.status},
            updated_at = ${input.now.toISOString()}
          WHERE tenant_id = ${input.principal.tenantId} AND share_id = ${input.principal.shareId} AND id = ${current.head_id}
        `;
        const result = receipt(input.principal, committed, input.requestId, {
          actor: mutationActor(input.principal, input.attestation),
          revision: input.planned.proposedRevision,
          uri: current.canonical_uri,
        });
        await transaction`
          INSERT INTO remote_memory.outbox_events(
            tenant_id, share_id, id, generation, event_type, aggregate_id
          ) VALUES (
            ${input.principal.tenantId}, ${input.principal.shareId}, ${randomUuidV4()},
            ${numeric(committed.share_generation)}, 'memory_head_changed', ${current.head_id}
          )
        `;
        await transaction`
          INSERT INTO remote_memory.audit_events(
            tenant_id, share_id, id, request_id, principal_id, workload_attestation_id,
            operation, result, policy_version, share_policy_version, generation
          ) VALUES (
            ${input.principal.tenantId}, ${input.principal.shareId}, ${randomUuidV4()}, ${input.requestId},
            ${input.principal.principalId}, ${input.attestation?.attestationId ?? null},
            ${`handoff_${input.input.operation}`}, 'committed', ${input.principal.policyVersion},
            ${committed.policy_version}, ${numeric(committed.share_generation)}
          )
        `;
        await this.recordIdempotentOutcome(
          transaction,
          input.principal,
          input.input.operationId,
          input.fingerprint,
          result,
        );
        return result;
      },
      input.execution,
    );
  }

  private async recordIdempotentOutcome(
    transaction: ISql,
    principal: AuthorizedRemotePrincipal,
    operationId: string,
    fingerprint: string,
    result: RemoteMemoryReceiptV1,
  ): Promise<void> {
    const recordedOutcomes = await transaction<{operation_id: string}[]>`
      UPDATE remote_memory.idempotency_records SET outcome = ${transaction.json(result)}
      WHERE tenant_id = ${principal.tenantId} AND principal_id = ${principal.principalId}
        AND operation_id = ${operationId} AND request_hash = ${fingerprint}
      RETURNING operation_id
    `;
    if (!recordedOutcomes[0]) {
      throw remoteMemoryError('service_unavailable', 'The remote operation outcome could not be recorded.');
    }
  }

  private async loadGitIngestPrincipal(
    tenantId: string,
    shareId: string,
  ): Promise<AuthorizedRemotePrincipal | undefined> {
    return this.withTenant(tenantId, async transaction => {
      const rows = await transaction<
        {
          readonly allowed_projects: string[] | null;
          readonly capabilities: string[];
          readonly feature_flags: string[];
          readonly grant_policy_digest: string;
          readonly grant_policy_version: string;
          readonly principal_id: string;
          readonly share_policy_digest: string;
          readonly share_policy_version: string;
        }[]
      >`
        SELECT g.principal_id, g.capabilities, g.allowed_projects,
          g.policy_version AS grant_policy_version, g.policy_digest AS grant_policy_digest,
          s.policy_version AS share_policy_version, s.policy_digest AS share_policy_digest,
          s.feature_flags
        FROM remote_memory.shares s
        JOIN remote_memory.share_grants g
          ON g.tenant_id = s.tenant_id AND g.share_id = s.id AND g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > now())
        JOIN remote_memory.principals p
          ON p.tenant_id = g.tenant_id AND p.id = g.principal_id AND p.status = 'active'
        JOIN remote_memory.tenant_memberships m
          ON m.tenant_id = g.tenant_id AND m.principal_id = g.principal_id AND m.status = 'active'
        WHERE s.tenant_id = ${tenantId} AND s.id = ${shareId} AND s.status = 'active'
          AND g.principal_id = ${remoteGitIngestPrincipalId(tenantId, shareId)}
      `;
      const row = rows[0];
      if (!row) return undefined;
      const capabilityValues = EffectArray.filter(row.capabilities, (capability): capability is RemoteMemoryScope =>
        remoteMemoryScopeSet.has(capability),
      );
      if (capabilityValues.length !== row.capabilities.length) {
        throw remoteMemoryError('service_unavailable', 'The Git ingestion grant contains an unsupported capability.');
      }
      const capabilities = new Set(capabilityValues);
      return {
        allowedProjects: row.allowed_projects === null ? 'all' : new Set(row.allowed_projects),
        attestationRequiredForWrites: false,
        capabilities,
        cloudAdmissionRequired: false,
        cursorOwnerIds: new Set(),
        cursorSubjects: new Set(),
        featureFlags: new Set(
          EffectArray.filter(row.feature_flags, (feature): feature is RemoteMemoryFeatureFlag =>
            remoteMemoryFeatureFlagSet.has(feature),
          ),
        ),
        OAuth: {
          issuer: 'threadnote:git-ingest',
          scopes: capabilities,
          subject: 'system:git-ingest',
        },
        policyDigest: row.grant_policy_digest,
        policyVersion: row.grant_policy_version,
        principalId: row.principal_id,
        repositoryBindings: new Set(),
        repositoriesByProject: new Map(),
        shareId,
        sharePolicyDigest: row.share_policy_digest,
        sharePolicyVersion: row.share_policy_version,
        tenantId,
      };
    });
  }

  private async reserveOperation(
    principal: AuthorizedRemotePrincipal,
    operationId: string,
    fingerprint: string,
    requestId: string,
    now: Date,
    execution?: RemoteMemoryRequestExecution,
    relations?: readonly MemoryRelation[],
    allowAmbiguousReplay = false,
  ): Promise<OperationReservation> {
    return this.withTenant(
      principal.tenantId,
      async transaction => {
        const existing = await transaction<IdempotencyRecordRow[]>`
          SELECT request_hash, outcome, outcome_expires_at
          FROM remote_memory.idempotency_records
          WHERE tenant_id = ${principal.tenantId} AND principal_id = ${principal.principalId}
            AND operation_id = ${operationId}
          FOR UPDATE
        `;
        if (existing[0]) {
          return operationReservationFromRecord(existing[0], fingerprint, requestId, now, allowAmbiguousReplay);
        }
        await this.requireActiveRelationTargets(transaction, principal, relations);
        const expiresAt = new Date(now.getTime() + IDEMPOTENCY_REPLAY_WINDOW_MILLISECONDS).toISOString();
        const ambiguousOutcome = storedOperationRejection(
          remoteMemoryError(
            'service_unavailable',
            'The operation outcome is unavailable and will not be re-executed.',
            {
              reason: 'outcome_ambiguous',
            },
          ),
        );
        const inserted = await transaction<{request_hash: string}[]>`
        INSERT INTO remote_memory.idempotency_records(
          tenant_id, share_id, principal_id, operation_id, request_hash, outcome, outcome_expires_at
        ) VALUES (
          ${principal.tenantId}, ${principal.shareId}, ${principal.principalId},
          ${operationId}, ${fingerprint}, ${transaction.json(requireJsonValue(ambiguousOutcome))}, ${expiresAt}
        ) ON CONFLICT DO NOTHING
        RETURNING request_hash
      `;
        if (inserted[0]) return {kind: 'execute'};

        const records = await transaction<IdempotencyRecordRow[]>`
        SELECT request_hash, outcome, outcome_expires_at
        FROM remote_memory.idempotency_records
        WHERE tenant_id = ${principal.tenantId} AND principal_id = ${principal.principalId}
          AND operation_id = ${operationId}
        FOR UPDATE
      `;
        const record = records[0];
        if (!record) {
          throw remoteMemoryError('idempotency_mismatch', 'The operation id was already used for a different request.');
        }
        return operationReservationFromRecord(record, fingerprint, requestId, now, allowAmbiguousReplay);
      },
      execution,
    );
  }

  private async retainRejectedOperation(
    principal: AuthorizedRemotePrincipal,
    operationId: string,
    fingerprint: string,
    cause: unknown,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<void> {
    const error = Schema.is(RemoteMemoryError)(cause)
      ? cause
      : remoteMemoryError('service_unavailable', 'Remote memory could not complete the request.');
    const rejection = storedOperationRejection(error);
    try {
      await this.withTenant(
        principal.tenantId,
        async transaction => {
          await transaction`
            UPDATE remote_memory.idempotency_records
            SET outcome = ${transaction.json(requireJsonValue(rejection))}
            WHERE tenant_id = ${principal.tenantId} AND principal_id = ${principal.principalId}
              AND operation_id = ${operationId} AND request_hash = ${fingerprint}
              AND outcome->>'kind' = 'rejected'
              AND outcome->'error'->'details'->>'reason' = 'outcome_ambiguous'
          `;
        },
        execution,
      );
    } catch {
      // The durable request-hash tombstone still prevents reuse or re-execution.
    }
  }

  private async finishProposalDecision(
    principal: AuthorizedRemotePrincipal,
    proposal: StoredRemoteMemoryProposalRow,
    input: RemoteMemoryProposalReviewInputV1,
    status: Exclude<RemoteMemoryProposalStatus, 'pending'>,
    result: RemoteMemoryReceiptV1 | undefined,
    attestation: CursorWorkloadAttestation | undefined,
    now: Date,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<RemoteMemoryProposalV1> {
    return finishStoredRemoteMemoryProposalDecision(
      principal,
      proposal,
      input,
      status,
      result,
      now,
      use => this.withTenant(principal.tenantId, use, execution),
      async transaction => {
        await acquireRemoteRelationAdmissionTransactionLock(transaction, principal.tenantId, principal.shareId);
        const state = await requireShareState(transaction, principal);
        await requireActiveProject(transaction, principal, proposal.project);
        requireFreshAttestationPolicy(principal, state, attestation, proposal.project);
      },
    );
  }

  private async requireCurrentMutationAuthority(
    principal: AuthorizedRemotePrincipal,
    attestation: CursorWorkloadAttestation | undefined,
    project: string,
    requiredValidityMilliseconds: number,
    execution?: RemoteMemoryRequestExecution,
    tenantTransaction?: TenantTransactionRunner,
  ): Promise<void> {
    const withTenant: TenantTransactionRunner =
      tenantTransaction ?? ((tenantId, use, requestExecution) => this.withTenant(tenantId, use, requestExecution));
    const state = await withTenant(
      principal.tenantId,
      async transaction => {
        const state = await requireShareState(transaction, principal);
        await requireActiveProject(transaction, principal, project);
        return state;
      },
      execution,
    );
    requireActiveRemoteMemoryRequest(execution);
    requireFreshAttestationPolicy(
      principal,
      state,
      attestation,
      project,
      mutationAuthorityValidThrough(execution, requiredValidityMilliseconds),
    );
  }

  private async withTenant<A>(
    tenantId: string,
    use: (transaction: ISql) => Promise<A>,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<A> {
    requireActiveRemoteMemoryRequest(execution);
    return await this.sql.begin<Promise<A>>(async transaction =>
      withRemoteMemoryRequestCancellation(transaction, execution, async cancellableTransaction => {
        const timeout = remoteMemoryDatabaseTimeoutMilliseconds(this.statementTimeoutMilliseconds, execution);
        await cancellableTransaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
        await cancellableTransaction`SELECT set_config('statement_timeout', ${String(timeout)}, true)`;
        await cancellableTransaction`SELECT set_config('lock_timeout', ${String(timeout)}, true)`;
        await cancellableTransaction`SELECT set_config('transaction_timeout', ${String(timeout)}, true)`;
        return use(cancellableTransaction);
      }),
    );
  }

  private async withRelationAdmissionFence<A>(
    principal: AuthorizedRemotePrincipal,
    execution: RemoteMemoryRequestExecution | undefined,
    use: (withTenant: TenantTransactionRunner) => Promise<A>,
  ): Promise<A> {
    requireActiveRemoteMemoryRequest(execution);
    const lockKey = remoteRelationAdmissionLockKey(principal.tenantId, principal.shareId);
    const connection = await this.sql.reserve();
    let locked = false;
    try {
      const withTenant: TenantTransactionRunner = (tenantId, transactionUse, requestExecution) =>
        this.withReservedTenant(connection, tenantId, transactionUse, requestExecution);
      await withTenant(
        principal.tenantId,
        async transaction => {
          await transaction`SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))`;
          locked = true;
        },
        execution,
      );
      requireActiveRemoteMemoryRequest(execution);
      return await use(withTenant);
    } finally {
      try {
        if (locked) await connection`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
      } finally {
        connection.release();
      }
    }
  }

  private async withReservedTenant<A>(
    connection: ReservedSql,
    tenantId: string,
    use: (transaction: ISql) => Promise<A>,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<A> {
    requireActiveRemoteMemoryRequest(execution);
    await connection.unsafe('BEGIN');
    try {
      const result = await withRemoteMemoryRequestCancellation(connection, execution, async transaction => {
        const timeout = remoteMemoryDatabaseTimeoutMilliseconds(this.statementTimeoutMilliseconds, execution);
        await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
        await transaction`SELECT set_config('statement_timeout', ${String(timeout)}, true)`;
        await transaction`SELECT set_config('lock_timeout', ${String(timeout)}, true)`;
        await transaction`SELECT set_config('transaction_timeout', ${String(timeout)}, true)`;
        return use(transaction);
      });
      await connection.unsafe('COMMIT');
      return result;
    } catch (cause) {
      try {
        await connection.unsafe('ROLLBACK');
      } catch {
        // A broken reserved connection is discarded when released below.
      }
      throw cause;
    }
  }
}

function operationReservationFromRecord(
  record: IdempotencyRecordRow,
  fingerprint: string,
  requestId: string,
  now: Date,
  allowAmbiguousReplay = false,
): OperationReservation {
  if (record.request_hash !== fingerprint) {
    throw remoteMemoryError('idempotency_mismatch', 'The operation id was already used for a different request.');
  }
  if (record.outcome_expires_at.getTime() <= now.getTime()) {
    throw remoteMemoryError('idempotency_mismatch', 'The operation replay outcome is no longer retained.', {
      reason: 'outcome_expired',
      replayWindowHours: IDEMPOTENCY_REPLAY_WINDOW_MILLISECONDS / 3_600_000,
    });
  }
  if (record.outcome !== null) {
    const publicationPlan = storedRememberPublicationPlan(record.outcome);
    if (publicationPlan) return {kind: 'execute', publicationPlan};
    if (allowAmbiguousReplay && isRetryableProposalOperationOutcome(record.outcome)) return {kind: 'execute'};
    const replay = readStoredOperationOutcome(record.outcome, requestId);
    if (Schema.is(RemoteMemoryError)(replay)) throw replay;
    return {kind: 'replay', receipt: replay};
  }
  throw remoteMemoryError('service_unavailable', 'The operation outcome is unavailable and will not be re-executed.', {
    reason: 'outcome_ambiguous',
  });
}
