import {Array as EffectArray} from 'effect';
import type {Sql, ISql} from 'postgres';
import {GitCanonicalMemoryStore} from './git/canonical_store.js';
import {assertGitMemoryBinding, requireGitMemoryBinding} from './git/binding.js';
import {PostgresRemoteMemoryRepository} from './postgres/repository.js';
import {parseMemoryDocument} from '@threadnote/memory/document';
import {formatRemoteMemoryUri} from '@threadnote/memory/remote/address';
import {replaceRemoteCodeLinkBacklinks} from './code_link_backlinks.js';
import {Option as EffectOption} from 'effect';

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_POLL_MILLISECONDS = 250;
const MAX_RETRY_MILLISECONDS = 60_000;
const MAX_PROJECTION_ATTEMPTS = 10;
const GIT_HYDRATE_LEASE_MILLISECONDS = 5_000;
const GIT_INGEST_INTERVAL_MILLISECONDS = 15_000;

interface ShareDirectoryRow {
  readonly share_id: string;
  readonly tenant_id: string;
}

interface OutboxRow {
  readonly aggregate_id: string;
  readonly attempts: number;
  readonly event_type: string;
  readonly generation: string | number;
  readonly id: string;
}

interface IndexerHealthAggregateRow {
  readonly dead_letters: string | number;
  readonly oldest_pending_at: Date | null;
  readonly pending_work: string | number;
}

type ProjectionResult = 'claimed_failed' | 'claimed_processed' | 'not_claimed';

interface ClaimedHead {
  readonly git_commit: string | null;
  readonly git_path: string | null;
  readonly head_id: string;
  readonly kind: 'durable' | 'handoff';
  readonly markdown_body: string;
  readonly project: string;
  readonly revision_id: string;
  readonly generation: string | number;
  readonly topic: string;
}

export interface RemoteMemoryIndexerOptions {
  readonly batchSize?: number;
  readonly pollMilliseconds?: number;
  readonly signal?: AbortSignal;
}

export interface RemoteMemoryIndexPassResult {
  readonly failed: number;
  readonly processed: number;
}

/**
 * Projects committed memory heads into the derived lexical index. A pass takes
 * at most one event per share before rotating, so one hot share cannot consume
 * the whole batch. Git-canonical blobs are hydrated after the outbox claim
 * commits. A SKIP LOCKED miss is never counted as progress.
 */
export class RemoteMemoryIndexer {
  private gitIngestFailed = false;
  private nextGitIngestAt = 0;
  private nextShareKey: string | undefined;

  constructor(
    readonly sql: Sql,
    readonly gitStore?: GitCanonicalMemoryStore,
  ) {
    if (gitStore) requireGitMemoryBinding(gitStore.binding);
  }

  async retryDeadLetters(input: {
    readonly eventId?: string;
    readonly shareId: string;
    readonly tenantId: string;
  }): Promise<number> {
    assertGitMemoryBinding(this.gitStore?.binding, input);
    return this.withTenant(input.tenantId, async transaction => {
      const rows = await transaction<{id: string}[]>`
        UPDATE remote_memory.outbox_events
        SET attempts = 0, available_at = now(), dead_lettered_at = NULL, last_error_class = NULL
        WHERE tenant_id = ${input.tenantId} AND share_id = ${input.shareId}
          AND dead_lettered_at IS NOT NULL
          AND (${input.eventId ?? null}::text IS NULL OR id = ${input.eventId ?? null})
        RETURNING id
      `;
      return rows.length;
    });
  }

  async runPass(
    options: Pick<RemoteMemoryIndexerOptions, 'batchSize'> & {readonly ingest?: boolean} = {},
  ): Promise<RemoteMemoryIndexPassResult> {
    const batchSize = boundedBatchSize(options.batchSize);
    const shares = rotateShares(await this.activeShares(), this.nextShareKey);
    let processed = 0;
    let failed = 0;
    let attempts = 0;
    let lastAttempted: ShareDirectoryRow | undefined;
    if (this.gitStore && options.ingest !== false) {
      try {
        await new PostgresRemoteMemoryRepository(this.sql, {gitStore: this.gitStore}).ingestActiveGitShares(
          `indexer-ingest:${Date.now()}`,
        );
        this.gitIngestFailed = false;
      } catch {
        this.gitIngestFailed = true;
        failed += 1;
      }
    }
    if (shares.length > 0) {
      while (attempts < batchSize) {
        let roundClaimed = 0;
        for (const share of shares) {
          if (attempts >= batchSize) break;
          lastAttempted = share;
          const outcome = await this.claimAndProject(share);
          if (outcome === 'not_claimed') continue;
          attempts += 1;
          roundClaimed += 1;
          if (outcome === 'claimed_processed') processed += 1;
          else failed += 1;
        }
        if (roundClaimed === 0) break;
      }
    }
    if (lastAttempted) this.nextShareKey = shareKeyAfter(shares, lastAttempted);
    await this.updateHealth(shares, {failed, processed});
    return {failed, processed};
  }

  async run(options: RemoteMemoryIndexerOptions = {}): Promise<void> {
    const pollMilliseconds = boundedPollMilliseconds(options.pollMilliseconds);
    while (!options.signal?.aborted) {
      const ingestDue = Date.now() >= this.nextGitIngestAt;
      const pass = await this.runPass({batchSize: options.batchSize, ingest: ingestDue});
      if (ingestDue && this.gitStore) {
        this.nextGitIngestAt = Date.now() + GIT_INGEST_INTERVAL_MILLISECONDS;
      }
      if (pass.processed + pass.failed === 0 && !options.signal?.aborted) {
        await waitForAbortableDelay(pollMilliseconds, options.signal);
      }
    }
  }

  private async activeShares(): Promise<readonly ShareDirectoryRow[]> {
    return this.sql<ShareDirectoryRow[]>`
      SELECT tenant_id, share_id FROM remote_memory.share_directory
      WHERE status = 'active'
        AND (${this.gitStore?.binding?.tenantId ?? null}::text IS NULL OR tenant_id = ${this.gitStore?.binding?.tenantId ?? null})
        AND (${this.gitStore?.binding?.shareId ?? null}::text IS NULL OR share_id = ${this.gitStore?.binding?.shareId ?? null})
      ORDER BY tenant_id, share_id
    `;
  }

  private async claimAndProject(share: ShareDirectoryRow): Promise<ProjectionResult> {
    const claimed = await this.sql.begin(async transaction => {
      await configureTenantTransaction(transaction, share.tenant_id);
      const locked = await transaction<OutboxRow[]>`
        SELECT id, aggregate_id, event_type, generation, attempts
        FROM remote_memory.outbox_events
        WHERE tenant_id = ${share.tenant_id} AND share_id = ${share.share_id}
          AND processed_at IS NULL AND available_at <= now() AND dead_lettered_at IS NULL
        ORDER BY generation, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `;
      const event = locked[0];
      if (!event) return {kind: 'not_claimed' as const};
      try {
        if (event.event_type !== 'memory_head_changed' && event.event_type !== 'code_link_backfill') {
          throw new Error('unsupported_outbox_event');
        }
        const head = await loadOutboxHead(transaction, share, event.aggregate_id);
        if (!head) throw new Error('missing_outbox_aggregate');
        if (head.markdown_body !== '' || !head.git_commit || !head.git_path) {
          await projectSearchDocument(transaction, share, event, head, head.markdown_body);
          return {kind: 'claimed_processed' as const};
        }
        await transaction`
          UPDATE remote_memory.outbox_events
          SET available_at = now() + (${GIT_HYDRATE_LEASE_MILLISECONDS} * interval '1 millisecond')
          WHERE tenant_id = ${share.tenant_id} AND share_id = ${share.share_id} AND id = ${event.id}
        `;
        return {event, head, kind: 'hydrate' as const};
      } catch (cause) {
        await markIndexerFailure(transaction, share, event, cause);
        return {kind: 'claimed_failed' as const};
      }
    });
    if (claimed.kind !== 'hydrate') return claimed.kind;
    try {
      if (!this.gitStore || !claimed.head.git_commit || !claimed.head.git_path) {
        throw new Error('missing_git_canonical_blob');
      }
      const body = await this.gitStore.read({commit: claimed.head.git_commit, path: claimed.head.git_path});
      return await this.sql.begin(async transaction => {
        await configureTenantTransaction(transaction, share.tenant_id);
        const locked = await transaction<OutboxRow[]>`
          SELECT id, aggregate_id, event_type, generation, attempts
          FROM remote_memory.outbox_events
          WHERE tenant_id = ${share.tenant_id} AND share_id = ${share.share_id} AND id = ${claimed.event.id}
            AND processed_at IS NULL AND dead_lettered_at IS NULL
          FOR UPDATE
        `;
        const event = locked[0];
        if (!event) return 'claimed_processed' as const;
        try {
          const current = await loadOutboxHead(transaction, share, event.aggregate_id);
          if (!current) throw new Error('missing_outbox_aggregate');
          if (current.revision_id !== claimed.head.revision_id) {
            await transaction`
              UPDATE remote_memory.outbox_events SET processed_at = now(), last_error_class = NULL
              WHERE tenant_id = ${share.tenant_id} AND share_id = ${share.share_id} AND id = ${event.id}
            `;
            await advanceContiguousGeneration(transaction, share);
            return 'claimed_processed' as const;
          }
          await projectSearchDocument(transaction, share, event, current, body);
          return 'claimed_processed' as const;
        } catch (cause) {
          await markIndexerFailure(transaction, share, event, cause);
          return 'claimed_failed' as const;
        }
      });
    } catch (cause) {
      return await this.sql.begin(async transaction => {
        await configureTenantTransaction(transaction, share.tenant_id);
        await markIndexerFailure(transaction, share, claimed.event, cause);
        return 'claimed_failed' as const;
      });
    }
  }

  private async updateHealth(shares: readonly ShareDirectoryRow[], result: RemoteMemoryIndexPassResult): Promise<void> {
    let deadLetters = 0;
    let pendingWork = 0;
    let oldestPendingAt: Date | undefined;
    for (const tenantId of new Set(EffectArray.map(shares, share => share.tenant_id))) {
      const rows = await this.withTenant(
        tenantId,
        transaction =>
          transaction<IndexerHealthAggregateRow[]>`
          SELECT count(*) FILTER (WHERE e.dead_lettered_at IS NULL) AS pending_work,
            count(*) FILTER (WHERE e.dead_lettered_at IS NOT NULL) AS dead_letters,
            min(e.created_at) AS oldest_pending_at
          FROM remote_memory.outbox_events e
          JOIN remote_memory.shares s ON s.tenant_id = e.tenant_id AND s.id = e.share_id
          WHERE e.tenant_id = ${tenantId} AND e.processed_at IS NULL AND s.status = 'active'
            AND (${this.gitStore?.binding?.shareId ?? null}::text IS NULL OR e.share_id = ${this.gitStore?.binding?.shareId ?? null})
        `,
      );
      const row = rows[0];
      pendingWork += Number(row?.pending_work ?? 0);
      deadLetters += Number(row?.dead_letters ?? 0);
      if (row?.oldest_pending_at && (!oldestPendingAt || row.oldest_pending_at < oldestPendingAt)) {
        oldestPendingAt = row.oldest_pending_at;
      }
    }
    const failureClass = this.gitIngestFailed
      ? 'git_ingest_failed'
      : result.failed > 0
        ? 'projection_failed'
        : deadLetters > 0
          ? 'dead_lettered_event'
          : undefined;
    await this.sql`
      UPDATE remote_memory.worker_health SET
        heartbeat_at = now(),
        last_success_at = CASE WHEN ${failureClass ?? null}::text IS NULL THEN now() ELSE last_success_at END,
        last_failure_at = CASE WHEN ${failureClass ?? null}::text IS NOT NULL THEN now() ELSE last_failure_at END,
        failure_class = ${failureClass ?? null}, pending_work = ${pendingWork + deadLetters},
        oldest_pending_at = ${oldestPendingAt?.toISOString() ?? null},
        updated_at = now()
      WHERE worker_name = 'indexer'
    `;
  }

  private async withTenant<A>(tenantId: string, use: (transaction: ISql) => Promise<A>): Promise<A> {
    return await this.sql.begin<Promise<A>>(async transaction => {
      await configureTenantTransaction(transaction, tenantId);
      return use(transaction);
    });
  }
}

export function remoteIndexerBackoffMilliseconds(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) return 1_000;
  return Math.min(MAX_RETRY_MILLISECONDS, 1_000 * 2 ** Math.min(attempts - 1, 16));
}

export function rotateShares<A extends {readonly share_id: string; readonly tenant_id: string}>(
  shares: readonly A[],
  nextShareKey: string | undefined,
): readonly A[] {
  if (!nextShareKey || shares.length < 2) return shares;
  const index = EffectOption.getOrElse(
    EffectArray.findFirstIndex(shares, share => shareKey(share) >= nextShareKey),
    () => -1,
  );
  if (index <= 0) return index === 0 ? shares : [...shares];
  return [...shares.slice(index), ...shares.slice(0, index)];
}

function shareKey(share: ShareDirectoryRow): string {
  return `${share.tenant_id}\u0000${share.share_id}`;
}

function shareKeyAfter(shares: readonly ShareDirectoryRow[], current: ShareDirectoryRow): string | undefined {
  if (shares.length === 0) return undefined;
  const index = EffectOption.getOrElse(
    EffectArray.findFirstIndex(shares, share => shareKey(share) === shareKey(current)),
    () => -1,
  );
  return shareKey(shares[(index + 1) % shares.length]);
}

async function loadOutboxHead(
  transaction: ISql,
  share: ShareDirectoryRow,
  headId: string,
): Promise<ClaimedHead | undefined> {
  const heads = await transaction<ClaimedHead[]>`
    SELECT h.id AS head_id, r.id AS revision_id, r.generation, h.project, h.topic, h.kind,
      r.markdown_body, r.git_commit, r.git_path
    FROM remote_memory.memory_heads h
    JOIN remote_memory.memory_revisions r
      ON r.tenant_id = h.tenant_id AND r.share_id = h.share_id AND r.id = h.current_revision_id
    WHERE h.tenant_id = ${share.tenant_id} AND h.share_id = ${share.share_id}
      AND h.id = ${headId}
    FOR UPDATE OF h
  `;
  return heads[0];
}

async function projectSearchDocument(
  transaction: ISql,
  share: ShareDirectoryRow,
  event: OutboxRow,
  head: ClaimedHead,
  body: string,
): Promise<void> {
  const uri = formatRemoteMemoryUri({
    kind: head.kind,
    project: head.project,
    shareId: share.share_id,
    topic: head.topic,
  });
  const record = parseMemoryDocument(uri, body);
  await replaceRemoteCodeLinkBacklinks(transaction, {
    citations: record?.metadata.codeCitations ?? [],
    headId: head.head_id,
    revisionId: head.revision_id,
    shareId: share.share_id,
    tenantId: share.tenant_id,
  });
  const projected = await transaction`
    INSERT INTO remote_memory.search_documents(
      tenant_id, share_id, head_id, revision_id, generation, project, topic, kind, searchable
    ) VALUES (
      ${share.tenant_id}, ${share.share_id}, ${head.head_id}, ${head.revision_id}, ${head.generation},
      ${head.project}, ${head.topic}, ${head.kind},
      to_tsvector('simple', ${`${head.project} ${head.topic} ${body}`})
    )
    ON CONFLICT (tenant_id, share_id, head_id) DO UPDATE SET
      revision_id = EXCLUDED.revision_id, generation = EXCLUDED.generation,
      project = EXCLUDED.project, topic = EXCLUDED.topic, kind = EXCLUDED.kind,
      searchable = EXCLUDED.searchable, updated_at = now()
    RETURNING head_id
  `;
  if (projected.length !== 1) throw new Error('missing_outbox_aggregate');
  await transaction`
    UPDATE remote_memory.outbox_events SET processed_at = now(), last_error_class = NULL
    WHERE tenant_id = ${share.tenant_id} AND share_id = ${share.share_id} AND id = ${event.id}
  `;
  await advanceContiguousGeneration(transaction, share);
}

async function markIndexerFailure(
  transaction: ISql,
  share: ShareDirectoryRow,
  event: OutboxRow,
  cause: unknown,
): Promise<void> {
  const nextAttempts = event.attempts + 1;
  await transaction`
    UPDATE remote_memory.outbox_events
    SET attempts = attempts + 1, last_error_class = ${classifyIndexerFailure(cause)},
      dead_lettered_at = CASE WHEN ${nextAttempts} >= ${MAX_PROJECTION_ATTEMPTS} THEN now() ELSE NULL END,
      available_at = now() + (${remoteIndexerBackoffMilliseconds(nextAttempts)} * interval '1 millisecond')
    WHERE tenant_id = ${share.tenant_id} AND share_id = ${share.share_id} AND id = ${event.id}
  `;
}

async function advanceContiguousGeneration(transaction: ISql, share: ShareDirectoryRow): Promise<void> {
  await transaction`
    UPDATE remote_memory.shares s SET indexed_generation = GREATEST(
      s.indexed_generation,
      COALESCE((
        SELECT MIN(e.generation) - 1 FROM remote_memory.outbox_events e
        WHERE e.tenant_id = s.tenant_id AND e.share_id = s.id AND e.processed_at IS NULL
      ), s.share_generation)
    ) WHERE s.tenant_id = ${share.tenant_id} AND s.id = ${share.share_id}
  `;
}

async function configureTenantTransaction(transaction: ISql, tenantId: string): Promise<void> {
  await transaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
  await transaction`SELECT set_config('statement_timeout', '10000', true)`;
  await transaction`SELECT set_config('lock_timeout', '5000', true)`;
  await transaction`SELECT set_config('transaction_timeout', '10000', true)`;
}

function classifyIndexerFailure(cause: unknown): string {
  if (cause instanceof Error && /^[a-z][a-z0-9_]{0,63}$/u.test(cause.message)) return cause.message;
  return 'projection_failed';
}

function boundedBatchSize(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? Math.min(value, 1_000) : DEFAULT_BATCH_SIZE;
}

function boundedPollMilliseconds(value: number | undefined): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 10
    ? Math.min(value, 60_000)
    : DEFAULT_POLL_MILLISECONDS;
}

async function waitForAbortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  const {promise, resolve} = Promise.withResolvers<void>();
  const timeout = setTimeout(finish, milliseconds);
  signal?.addEventListener('abort', finish, {once: true});
  function finish(): void {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', finish);
    resolve();
  }
  await promise;
}
