import type {Sql, ISql} from 'postgres';
import type {AuthorizedRemotePrincipal} from './authorization.js';
import {remoteMemoryError} from './errors.js';
import {
  remoteMemoryDatabaseTimeoutMilliseconds,
  requireActiveRemoteMemoryRequest,
  withRemoteMemoryRequestCancellation,
  type RemoteMemoryRequestExecution,
} from './request_execution.js';

export const REMOTE_MEMORY_RATE_LIMIT_OPERATIONS = [
  'begin_cursor_attestation',
  'context_brief',
  'list_context',
  'memory_status',
  'list_memory_proposals',
  'propose_durable_memory',
  'read_memory_proposal',
  'read_context',
  'recall_context',
  'remember_context',
  'review_memory_proposal',
  'transition_handoff',
] as const;

export type RemoteMemoryRateLimitOperation = (typeof REMOTE_MEMORY_RATE_LIMIT_OPERATIONS)[number];

export interface RemoteMemoryRateLimiter {
  readonly consume: (
    principal: AuthorizedRemotePrincipal,
    operation: RemoteMemoryRateLimitOperation,
    execution?: RemoteMemoryRequestExecution,
  ) => Promise<void>;
}

export interface PostgresRemoteRateLimiterOptions {
  readonly readRequestsPerMinute: number;
  readonly writeRequestsPerMinute: number;
}

interface RateLimitRow {
  readonly request_count: string | number;
  readonly window_started_at: Date;
}

/** Database-backed limiter keyed by authorized tenant, principal, share, and operation. */
export class PostgresRemoteRateLimiter implements RemoteMemoryRateLimiter {
  constructor(
    readonly sql: Sql,
    readonly options: PostgresRemoteRateLimiterOptions,
  ) {}

  async consume(
    principal: AuthorizedRemotePrincipal,
    operation: RemoteMemoryRateLimitOperation,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<void> {
    const limit = isWriteOperation(operation)
      ? this.options.writeRequestsPerMinute
      : this.options.readRequestsPerMinute;
    const row = await this.withTenant(
      principal.tenantId,
      async transaction => {
        const rows = await transaction<RateLimitRow[]>`
        INSERT INTO remote_memory.rate_limit_windows(
          tenant_id, share_id, principal_id, operation, window_started_at, request_count
        ) VALUES (
          ${principal.tenantId}, ${principal.shareId}, ${principal.principalId}, ${operation},
          date_trunc('minute', now()), 1
        )
        ON CONFLICT (tenant_id, share_id, principal_id, operation) DO UPDATE SET
          window_started_at = CASE
            WHEN remote_memory.rate_limit_windows.window_started_at < date_trunc('minute', now())
              THEN date_trunc('minute', now())
            ELSE remote_memory.rate_limit_windows.window_started_at
          END,
          request_count = CASE
            WHEN remote_memory.rate_limit_windows.window_started_at < date_trunc('minute', now()) THEN 1
            ELSE remote_memory.rate_limit_windows.request_count + 1
          END
        RETURNING request_count, window_started_at
      `;
        return rows[0];
      },
      execution,
    );
    if (!row) throw remoteMemoryError('service_unavailable', 'Remote memory rate limiting is unavailable.');
    if (numeric(row.request_count) > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((row.window_started_at.getTime() + 60_000 - Date.now()) / 1_000));
      throw remoteMemoryError('rate_limited', 'The remote memory operation rate limit was exceeded.', {
        retryAfterSeconds,
      });
    }
  }

  private async withTenant<A>(
    tenantId: string,
    use: (transaction: ISql) => Promise<A>,
    execution?: RemoteMemoryRequestExecution,
  ): Promise<A> {
    requireActiveRemoteMemoryRequest(execution);
    return await this.sql.begin<Promise<A>>(async transaction =>
      withRemoteMemoryRequestCancellation(transaction, execution, async cancellableTransaction => {
        const timeout = remoteMemoryDatabaseTimeoutMilliseconds(5_000, execution);
        await cancellableTransaction`SELECT set_config('threadnote.tenant_id', ${tenantId}, true)`;
        await cancellableTransaction`SELECT set_config('statement_timeout', ${String(timeout)}, true)`;
        await cancellableTransaction`SELECT set_config('lock_timeout', ${String(timeout)}, true)`;
        await cancellableTransaction`SELECT set_config('transaction_timeout', ${String(timeout)}, true)`;
        return use(cancellableTransaction);
      }),
    );
  }
}

function isWriteOperation(operation: RemoteMemoryRateLimitOperation): boolean {
  return (
    operation === 'propose_durable_memory' ||
    operation === 'remember_context' ||
    operation === 'review_memory_proposal' ||
    operation === 'transition_handoff'
  );
}

function numeric(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw remoteMemoryError('service_unavailable', 'Remote memory rate-limit state was invalid.');
  }
  return parsed;
}
