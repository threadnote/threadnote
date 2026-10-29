import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import {randomUuidV4} from '@threadnote/platform/uuid';
import type {Sql, ISql} from 'postgres';
import type {AuthorizedRemotePrincipal} from './authorization.js';
import {RemoteMemoryError} from './errors.js';
import {rotateShares} from './indexer.js';
import {PostgresRemoteMemoryRepository} from './postgres/repository.js';
import {remoteRetentionPrincipalId} from './postgres/control_plane.js';
import type {GitCanonicalMemoryStore} from './git/canonical_store.js';
import {REMOTE_MEMORY_PROPOSAL_CLAIM_LEASE_MILLISECONDS} from './proposals.js';

const DEFAULT_RETENTION_LIMIT = 64;
const DEFAULT_RETENTION_POLL_MILLISECONDS = 60_000;
const CLEANUP_TENANT_BATCH = 64;
const CLEANUP_ROWS_PER_TENANT = 32;
const CHALLENGE_CLEANUP_LIMIT = 1_000;

interface ExpiredHandoffRow {
  readonly canonical_uri: string;
  readonly current_revision_id: string;
  readonly head_id: string;
  readonly policy_version: string;
  readonly policy_digest: string;
  readonly share_policy_digest: string;
  readonly share_policy_version: string;
  readonly principal_id: string;
  readonly share_id: string;
  readonly tenant_id: string;
}

interface RetentionShareRow {
  readonly share_id: string;
  readonly tenant_id: string;
}

export interface RemoteHandoffRetentionPassResult {
  readonly conflicted: number;
  readonly expired: number;
}

export interface RemoteHandoffRetentionRunOptions {
  readonly limit?: number;
  readonly pollMilliseconds?: number;
  readonly signal?: AbortSignal;
}

/**
 * Converts explicitly expiring active handoffs to a non-destructive expired
 * state. Each round takes at most one handoff per share. Cleanup retains
 * idempotency request-hash tombstones and minimizes expired workload identity.
 */
export class RemoteHandoffRetentionWorker {
  readonly repository: PostgresRemoteMemoryRepository;
  private nextCleanupTenantKey: string | undefined;
  private nextShareKey: string | undefined;

  constructor(
    readonly sql: Sql,
    options: {readonly gitStore?: GitCanonicalMemoryStore} = {},
  ) {
    this.repository = new PostgresRemoteMemoryRepository(sql, options);
  }

  async runPass(limit = DEFAULT_RETENTION_LIMIT, now = new Date()): Promise<RemoteHandoffRetentionPassResult> {
    try {
      const candidates = await this.candidates(boundedLimit(limit), now);
      let expired = 0;
      let conflicted = 0;
      for (const candidate of candidates) {
        try {
          await this.repository.transitionHandoff(
            retentionPrincipal(candidate),
            {
              baseRevision: candidate.current_revision_id,
              operation: 'expire',
              operationId: remoteHandoffExpiryOperationId(candidate.head_id, candidate.current_revision_id),
              uri: candidate.canonical_uri,
            },
            `retention:${randomUuidV4()}`,
            undefined,
            now,
          );
          expired += 1;
        } catch (cause) {
          // A concurrent worker/member transition wins through normal CAS. Only
          // the committed worker counts expiry; the loser reports contention.
          if (!Schema.is(RemoteMemoryError)(cause) || (cause.code !== 'conflict' && cause.code !== 'not_found')) {
            throw cause;
          }
          conflicted += 1;
        }
      }
      await this.cleanupExpiredControlState(now);
      await this.updateHealth({failureClass: undefined, pendingWork: candidates.length >= boundedLimit(limit) ? 1 : 0});
      return {conflicted, expired};
    } catch (cause) {
      await this.updateHealth({failureClass: retentionFailureClass(cause), pendingWork: 0}).catch(() => undefined);
      throw cause;
    }
  }

  async run(options: RemoteHandoffRetentionRunOptions = {}): Promise<void> {
    const pollMilliseconds = boundedPollMilliseconds(options.pollMilliseconds);
    while (!options.signal?.aborted) {
      await this.runPass(options.limit);
      await abortableDelay(pollMilliseconds, options.signal);
    }
  }

  private async cleanupExpiredControlState(now: Date): Promise<void> {
    await this.cleanupChallenges(now);
    const tenants = rotateTenantIds(await this.cleanupTenants(), this.nextCleanupTenantKey).slice(
      0,
      CLEANUP_TENANT_BATCH,
    );
    const lastTenant = tenants.at(-1);
    if (lastTenant) this.nextCleanupTenantKey = `${lastTenant}\u0000`;
    for (const tenantId of tenants) {
      await this.withTenant(tenantId, async transaction => {
        // Preserve (tenant, principal, operation, request_hash) forever so an
        // expired replay payload cannot make an operation ID reusable.
        await transaction`
          UPDATE remote_memory.idempotency_records SET outcome = NULL WHERE ctid IN (
            SELECT ctid FROM remote_memory.idempotency_records
            WHERE tenant_id = ${tenantId} AND outcome IS NOT NULL
              AND outcome_expires_at <= ${now.toISOString()}
            ORDER BY outcome_expires_at, operation_id LIMIT ${CLEANUP_ROWS_PER_TENANT}
          )
        `;
        await transaction`
          DELETE FROM remote_memory.uri_aliases WHERE ctid IN (
            SELECT ctid FROM remote_memory.uri_aliases
            WHERE tenant_id = ${tenantId} AND expires_at IS NOT NULL AND expires_at <= ${now.toISOString()}
            ORDER BY expires_at, alias_uri LIMIT ${CLEANUP_ROWS_PER_TENANT}
          )
        `;
        await transaction`
          UPDATE remote_memory.workload_attestations SET
            issuer = 'expired', subject = 'expired',
            jwt_id = tenant_id || ':' || share_id || ':' || id, cloud_agent_id = 'expired',
            turn_id = NULL, team_id = NULL, owner_id = NULL, repository_urls = NULL
          WHERE ctid IN (
            SELECT ctid FROM remote_memory.workload_attestations
            WHERE tenant_id = ${tenantId} AND expires_at <= ${now.toISOString()}
              AND (issuer <> 'expired' OR subject <> 'expired' OR cloud_agent_id <> 'expired')
            ORDER BY expires_at, id LIMIT ${CLEANUP_ROWS_PER_TENANT}
          )
        `;
        const staleClaimCutoff = new Date(
          now.getTime() - REMOTE_MEMORY_PROPOSAL_CLAIM_LEASE_MILLISECONDS,
        ).toISOString();
        await transaction`
          UPDATE remote_memory.durable_memory_proposals SET
            status = 'expired', payload = NULL, payload_purged_at = ${now.toISOString()},
            reviewed_at = COALESCE(reviewed_at, ${now.toISOString()})
          WHERE ctid IN (
            SELECT ctid FROM remote_memory.durable_memory_proposals
            WHERE tenant_id = ${tenantId} AND status = 'pending' AND expires_at <= ${now.toISOString()}
              AND (decision_claimed_at IS NULL OR decision_claimed_at <= ${staleClaimCutoff})
            ORDER BY expires_at, id LIMIT ${CLEANUP_ROWS_PER_TENANT}
          )
        `;
        await transaction`
          UPDATE remote_memory.durable_memory_proposals SET
            payload = NULL, payload_purged_at = ${now.toISOString()}
          WHERE ctid IN (
            SELECT ctid FROM remote_memory.durable_memory_proposals
            WHERE tenant_id = ${tenantId} AND status <> 'pending' AND payload IS NOT NULL
              AND expires_at <= ${now.toISOString()}
            ORDER BY expires_at, id LIMIT ${CLEANUP_ROWS_PER_TENANT}
          )
        `;
      });
    }
  }

  private async cleanupChallenges(now: Date): Promise<void> {
    const challenges = await this.sql<{challenge_id: string; tenant_id: string}[]>`
      SELECT challenge_id, tenant_id FROM remote_memory.challenge_directory
      WHERE expires_at <= ${now.toISOString()}
      ORDER BY expires_at, challenge_id LIMIT ${CHALLENGE_CLEANUP_LIMIT}
    `;
    const challengesByTenant = new Map<string, string[]>();
    for (const challenge of challenges) {
      const ids = challengesByTenant.get(challenge.tenant_id) ?? [];
      ids.push(challenge.challenge_id);
      challengesByTenant.set(challenge.tenant_id, ids);
    }
    for (const [tenantId, ids] of challengesByTenant) {
      await this.withTenant(tenantId, async transaction => {
        await transaction`
          DELETE FROM remote_memory.attestation_challenges
          WHERE tenant_id = ${tenantId} AND id = ANY(${transaction.array(ids)})
        `;
      });
    }
    if (challenges.length > 0) {
      await this.sql`
        DELETE FROM remote_memory.challenge_directory
        WHERE challenge_id = ANY(${this.sql.array(EffectArray.map(challenges, challenge => challenge.challenge_id))})
      `;
    }
  }

  private async cleanupTenants(): Promise<readonly string[]> {
    const rows = await this.sql<{tenant_id: string}[]>`
      SELECT DISTINCT tenant_id FROM remote_memory.share_directory ORDER BY tenant_id
    `;
    return EffectArray.map(rows, row => row.tenant_id);
  }

  private async candidates(limit: number, now: Date): Promise<readonly ExpiredHandoffRow[]> {
    const shares = rotateShares(
      await this.sql<RetentionShareRow[]>`
        SELECT tenant_id, share_id FROM remote_memory.share_directory
        WHERE status = 'active'
          AND (${this.repository.gitStore?.binding?.tenantId ?? null}::text IS NULL OR tenant_id = ${this.repository.gitStore?.binding?.tenantId ?? null})
          AND (${this.repository.gitStore?.binding?.shareId ?? null}::text IS NULL OR share_id = ${this.repository.gitStore?.binding?.shareId ?? null})
        ORDER BY tenant_id, share_id
      `,
      this.nextShareKey,
    );
    const result: ExpiredHandoffRow[] = [];
    let lastScanned: RetentionShareRow | undefined;
    for (const share of shares) {
      lastScanned = share;
      const rows = await this.withTenant(
        share.tenant_id,
        transaction =>
          transaction<ExpiredHandoffRow[]>`
          SELECT h.tenant_id, h.share_id, h.id AS head_id, h.canonical_uri,
            h.current_revision_id, g.policy_version, g.policy_digest, g.principal_id,
            s.policy_version AS share_policy_version, s.policy_digest AS share_policy_digest
          FROM remote_memory.memory_heads h
          JOIN remote_memory.shares s ON s.tenant_id = h.tenant_id AND s.id = h.share_id
          JOIN remote_memory.share_grants g
            ON g.tenant_id = h.tenant_id AND g.share_id = h.share_id
            AND g.principal_id = ${remoteRetentionPrincipalId(share.tenant_id)}
            AND g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > now())
            AND 'memory:admin' = ANY(g.capabilities)
          WHERE h.tenant_id = ${share.tenant_id} AND h.share_id = ${share.share_id}
            AND h.kind = 'handoff' AND h.status = 'active'
            AND h.expires_at IS NOT NULL AND h.expires_at <= ${now.toISOString()}
            AND s.status = 'active'
          ORDER BY h.expires_at, h.id LIMIT 1
        `,
      );
      if (rows[0]) result.push(rows[0]);
      if (result.length >= limit) break;
    }
    if (lastScanned && shares.length > 0) {
      const index = EffectOption.getOrElse(
        EffectArray.findFirstIndex(shares, share => shareKey(share) === shareKey(lastScanned)),
        () => -1,
      );
      this.nextShareKey = shareKey(shares[(index + 1) % shares.length]);
    }
    return result;
  }

  private async updateHealth(input: {readonly failureClass: string | undefined; readonly pendingWork: number}) {
    await this.sql`
      UPDATE remote_memory.worker_health SET heartbeat_at = now(),
        last_success_at = CASE WHEN ${input.failureClass ?? null}::text IS NULL THEN now() ELSE last_success_at END,
        last_failure_at = CASE WHEN ${input.failureClass ?? null}::text IS NOT NULL THEN now() ELSE last_failure_at END,
        failure_class = ${input.failureClass ?? null}, pending_work = ${input.pendingWork},
        oldest_pending_at = NULL, updated_at = now()
      WHERE worker_name = 'retention'
    `;
  }

  private async withTenant<A>(tenantId: string, use: (transaction: ISql) => Promise<A>): Promise<A> {
    return await this.sql.begin<Promise<A>>(async transaction => {
      await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
      await transaction`SELECT set_config('statement_timeout', '10000', true)`;
      await transaction`SELECT set_config('lock_timeout', '5000', true)`;
      await transaction`SELECT set_config('transaction_timeout', '10000', true)`;
      return use(transaction);
    });
  }
}

export function remoteHandoffExpiryOperationId(headId: string, revisionId: string): string {
  return `expiry:${headId}:${revisionId}`;
}

export function rotateTenantIds(tenantIds: readonly string[], cursor: string | undefined): readonly string[] {
  if (!cursor || tenantIds.length < 2) return tenantIds;
  const index = EffectOption.getOrElse(
    EffectArray.findFirstIndex(tenantIds, tenantId => tenantId >= cursor),
    () => -1,
  );
  if (index <= 0) return index === 0 ? tenantIds : [...tenantIds];
  return [...tenantIds.slice(index), ...tenantIds.slice(0, index)];
}

function retentionPrincipal(row: ExpiredHandoffRow): AuthorizedRemotePrincipal {
  return {
    allowedProjects: 'all',
    attestationRequiredForWrites: false,
    capabilities: new Set(['memory:admin']),
    cloudAdmissionRequired: false,
    cursorOwnerIds: new Set(),
    cursorSubjects: new Set(),
    featureFlags: new Set(),
    OAuth: {issuer: 'threadnote:retention', scopes: new Set(['memory:admin']), subject: 'system:retention'},
    policyVersion: row.policy_version,
    policyDigest: row.policy_digest,
    principalId: row.principal_id,
    repositoryBindings: new Set(),
    repositoriesByProject: new Map(),
    shareId: row.share_id,
    sharePolicyDigest: row.share_policy_digest,
    sharePolicyVersion: row.share_policy_version,
    tenantId: row.tenant_id,
  };
}

function shareKey(share: RetentionShareRow): string {
  return `${share.tenant_id}\u0000${share.share_id}`;
}

function boundedLimit(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1_000) : DEFAULT_RETENTION_LIMIT;
}

function boundedPollMilliseconds(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 1_000
    ? Math.min(value, 60 * 60_000)
    : DEFAULT_RETENTION_POLL_MILLISECONDS;
}

function retentionFailureClass(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : 'retention_failed';
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) ? name : 'retention_failed';
}

async function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  const {promise, resolve} = Promise.withResolvers<void>();
  const timeout = setTimeout(done, milliseconds);
  signal?.addEventListener('abort', done, {once: true});
  function done(): void {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', done);
    resolve();
  }
  await promise;
}
