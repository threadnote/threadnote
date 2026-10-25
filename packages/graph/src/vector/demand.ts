import {Effect} from 'effect';
import type * as SqlClient from 'effect/sql/SqlClient';
import {CodeGraphStoreError} from '../types.js';
import {CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY} from '../index_scope.js';
import {CODE_GRAPH_SNAPSHOT_ID, validCanonicalTimestamp} from '../store/reconciliation/core.js';
import {CODE_GRAPH_EMBEDDING_DEMAND_TABLE_SQL} from '../store/schema/contracts.js';
import {CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION} from '../store/schema/revision.js';
import {
  acknowledgeCodeGraphEmbeddingDemandLane,
  claimCodeGraphEmbeddingDemandLane,
  enqueueCodeGraphEmbeddingDemandLane,
  codeGraphEmbeddingDemandSameTarget,
  codeGraphEmbeddingDemandSameModel,
  CODE_GRAPH_EMBEDDING_DEMAND_PAGE_SIZE,
  type CodeGraphEmbeddingDemandLane,
  type CodeGraphEmbeddingDemandClaim,
  type CodeGraphEmbeddingDemandOwner,
  type CodeGraphEmbeddingDemandModel,
  type CodeGraphEmbeddingDemandTarget,
  type CodeGraphEmbeddingDemandAcknowledgement,
} from './demand_scheduler.js';
export type {
  CodeGraphEmbeddingDemandLane,
  CodeGraphEmbeddingDemandClaim,
  CodeGraphEmbeddingDemandOwner,
  CodeGraphEmbeddingDemandModel,
  CodeGraphEmbeddingDemandTarget,
  CodeGraphEmbeddingDemandAcknowledgement,
} from './demand_scheduler.js';

export {
  CODE_GRAPH_EMBEDDING_DEMAND_TABLE_SQL,
  CODE_GRAPH_EMBEDDING_DEMAND_TABLE_CONTRACT,
} from '../store/schema/contracts.js';
export const CODE_GRAPH_EMBEDDING_DEMAND_WRITE_BOUNDARY = {
  operation: 'write code graph embedding demand',
  rowCount: 1,
  finalFactBytes: 8192,
} as const;
const normalizeSql = (sql: string) =>
  sql
    .replace(/CREATE TABLE IF NOT EXISTS/u, 'CREATE TABLE')
    .replaceAll(/\s+/gu, ' ')
    .trim();
export const codeGraphEmbeddingDemandSchemaState = Effect.fn('codeGraph.embeddingDemandSchemaState')(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql.unsafe<{readonly type: string; readonly sql: string}>(
    "SELECT type, sql FROM sqlite_master WHERE name = 'embedding_demand' COLLATE NOCASE LIMIT 2",
  );
  if (rows.length === 0) return 'absent' as const;
  if (
    rows.length !== 1 ||
    rows[0]?.type !== 'table' ||
    normalizeSql(rows[0].sql) !== normalizeSql(CODE_GRAPH_EMBEDDING_DEMAND_TABLE_SQL)
  )
    return 'incompatible' as const;
  const triggers = yield* sql.unsafe(
    "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'embedding_demand' LIMIT 1",
  );
  const indexes = yield* sql.unsafe('PRAGMA index_list(embedding_demand)');
  return triggers.length === 0 && indexes.length === 1 ? ('ready' as const) : ('incompatible' as const);
});
export const initializeCodeGraphEmbeddingDemandSchema = Effect.fn('codeGraph.initializeEmbeddingDemandSchema')(
  function* (sql: SqlClient.SqlClient) {
    const state = yield* codeGraphEmbeddingDemandSchemaState(sql);
    if (state === 'incompatible')
      return yield* CodeGraphStoreError.of('Code graph embedding demand schema is incompatible.');
    if (state === 'absent') yield* sql.unsafe(CODE_GRAPH_EMBEDDING_DEMAND_TABLE_SQL);
  },
);
const requireDemandSchema = Effect.fn('codeGraph.requireEmbeddingDemandSchema')(function* (
  sql: SqlClient.SqlClient,
  mutation: boolean,
) {
  const metadata = yield* sql.unsafe(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_metadata' LIMIT 1",
  );
  const versions =
    metadata.length === 0
      ? []
      : yield* sql.unsafe<{readonly value: string}>(
          "SELECT value FROM schema_metadata WHERE key = 'persistent_extension_schema_revision' LIMIT 2",
        );
  if (versions.length > 1 || (versions[0] && !/^(?:0|[1-9][0-9]{0,14})$/u.test(versions[0].value)))
    return yield* CodeGraphStoreError.of('Code graph embedding demand version is invalid.');
  const version = Number(versions[0]?.value ?? 0);
  if (!Number.isSafeInteger(version) || version > CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION)
    return yield* CodeGraphStoreError.of('Code graph embedding demand mutation version is unsupported.');
  const state = yield* codeGraphEmbeddingDemandSchemaState(sql);
  if (!mutation && state === 'absent' && version < CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION) return false;
  if (state !== 'ready' || version !== CODE_GRAPH_PERSISTENT_SCHEMA_CURRENT_REVISION)
    return yield* CodeGraphStoreError.of('Code graph embedding demand schema requires write preparation.');
  return true;
});
interface DemandRow {
  readonly worktree_id: string;
  readonly scope_id: string;
  readonly snapshot_id: string;
  readonly activated_at: string;
  readonly state: CodeGraphEmbeddingDemandLane['state'];
  readonly attempt: number;
  readonly not_before: number;
  readonly reason: string | null;
  readonly model_json: string | null;
  readonly active_json: string | null;
}
export interface CodeGraphEmbeddingDemandLaneIdentity {
  readonly worktreeId: string;
  readonly scopeId?: string;
}
const scopeOf = (lane: CodeGraphEmbeddingDemandLaneIdentity) => lane.scopeId ?? CODE_GRAPH_FULL_REPOSITORY_SCOPE_KEY;
const boundedText = (value: unknown, maximum: number) =>
  typeof value === 'string' &&
  value.length > 0 &&
  new TextEncoder().encode(value).length <= maximum &&
  !value.includes('\0');
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every(key => keys.includes(key))
  );
}
function validModel(model: CodeGraphEmbeddingDemandModel): boolean {
  return (
    exactKeys(model, ['id', 'sha256', 'dimensions', 'templateVersion']) &&
    boundedText(model.id, 256) &&
    /^[0-9a-f]{64}$/u.test(model.sha256) &&
    Number.isSafeInteger(model.dimensions) &&
    model.dimensions > 0 &&
    model.dimensions <= 65_536 &&
    Number.isSafeInteger(model.templateVersion) &&
    model.templateVersion >= 0
  );
}
function validClaim(claim: CodeGraphEmbeddingDemandClaim): boolean {
  return (
    exactKeys(claim, ['worktreeId', 'scopeId', 'snapshotId', 'activatedAt', 'owner', 'model', 'expiresAt']) &&
    exactKeys(claim.owner, ['token', 'processId', 'processStartIdentity']) &&
    /^[0-9a-f]{64}$/u.test(claim.worktreeId) &&
    boundedText(claim.scopeId, 256) &&
    CODE_GRAPH_SNAPSHOT_ID.test(claim.snapshotId) &&
    validCanonicalTimestamp(claim.activatedAt) &&
    validModel(claim.model) &&
    boundedText(claim.owner.token, 256) &&
    Number.isSafeInteger(claim.owner.processId) &&
    claim.owner.processId > 0 &&
    boundedText(claim.owner.processStartIdentity, 256) &&
    Number.isSafeInteger(claim.expiresAt) &&
    claim.expiresAt >= 0
  );
}
function decodeDemand(row: DemandRow): CodeGraphEmbeddingDemandLane {
  const model: CodeGraphEmbeddingDemandModel | undefined = row.model_json ? JSON.parse(row.model_json) : undefined;
  const active: CodeGraphEmbeddingDemandClaim | undefined = row.active_json ? JSON.parse(row.active_json) : undefined;
  if (
    (row.model_json !== null && JSON.stringify(model) !== row.model_json) ||
    (row.active_json !== null && JSON.stringify(active) !== row.active_json) ||
    (row.model_json !== null && !validModel(model!)) ||
    (row.active_json !== null && !validClaim(active!)) ||
    !/^[0-9a-f]{64}$/u.test(row.worktree_id) ||
    !boundedText(row.scope_id, 256) ||
    !CODE_GRAPH_SNAPSHOT_ID.test(row.snapshot_id) ||
    !validCanonicalTimestamp(row.activated_at) ||
    !['queued', 'building', 'deferred', 'blocked', 'ready', 'cancelled'].includes(row.state) ||
    !Number.isSafeInteger(row.attempt) ||
    row.attempt < 0 ||
    row.attempt > 3 ||
    !Number.isSafeInteger(row.not_before) ||
    row.not_before < 0 ||
    (row.reason !== null && !boundedText(row.reason, 2048)) ||
    (active && (active.worktreeId !== row.worktree_id || active.scopeId !== row.scope_id))
  )
    throw CodeGraphStoreError.of('Code graph embedding demand row is invalid.');
  return {
    worktreeId: row.worktree_id,
    scopeId: row.scope_id,
    snapshotId: row.snapshot_id,
    activatedAt: row.activated_at,
    state: row.state,
    attempt: row.attempt,
    notBefore: row.not_before,
    ...(row.reason ? {reason: row.reason} : {}),
    ...(model ? {model} : {}),
    ...(active ? {active} : {}),
  };
}
const readLane = Effect.fn('codeGraph.readEmbeddingDemandLane')(function* (
  sql: SqlClient.SqlClient,
  lane: CodeGraphEmbeddingDemandLaneIdentity,
) {
  const rows = yield* sql.unsafe<DemandRow>(
    'SELECT * FROM embedding_demand WHERE worktree_id = ? AND scope_id = ? LIMIT 1',
    [lane.worktreeId, scopeOf(lane)],
  );
  return rows[0]
    ? yield* Effect.try({
        try: () => decodeDemand(rows[0]),
        catch: () => CodeGraphStoreError.of('Code graph embedding demand row is invalid.'),
      })
    : undefined;
});
/** Bounded observation of one logical view; never prepares or migrates its schema. */
export const readCodeGraphEmbeddingDemandLane = Effect.fn('codeGraph.observeEmbeddingDemandLane')(function* (
  sql: SqlClient.SqlClient,
  lane: CodeGraphEmbeddingDemandLaneIdentity,
) {
  if (!(yield* requireDemandSchema(sql, false))) return undefined;
  return yield* readLane(sql, lane);
});

/** Startup recovery checks recorded intent only, without preparing storage. */
export const hasCodeGraphEmbeddingDemand = Effect.fn('codeGraph.hasEmbeddingDemand')(function* (
  sql: SqlClient.SqlClient,
) {
  if (!(yield* requireDemandSchema(sql, false))) return false;
  const rows = yield* sql.unsafe(
    "SELECT 1 FROM embedding_demand WHERE state IN ('queued', 'building', 'deferred', 'blocked') LIMIT 1",
  );
  return rows.length === 1;
});

const writeLane = (sql: SqlClient.SqlClient, lane: CodeGraphEmbeddingDemandLane) =>
  sql.unsafe(
    `INSERT INTO embedding_demand
  (worktree_id, scope_id, snapshot_id, activated_at, state, attempt, not_before, reason, model_json, active_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(worktree_id, scope_id) DO UPDATE SET snapshot_id=excluded.snapshot_id, activated_at=excluded.activated_at, state=excluded.state,
    attempt=excluded.attempt, not_before=excluded.not_before, reason=excluded.reason, model_json=excluded.model_json, active_json=excluded.active_json`,
    [
      lane.worktreeId,
      lane.scopeId,
      lane.snapshotId,
      lane.activatedAt,
      lane.state,
      lane.attempt,
      lane.notBefore,
      lane.reason ?? null,
      lane.model ? JSON.stringify(lane.model) : null,
      lane.active ? JSON.stringify(lane.active) : null,
    ],
  );
const targetCurrent = Effect.fn('codeGraph.embeddingDemandTargetCurrent')(function* (
  sql: SqlClient.SqlClient,
  target: CodeGraphEmbeddingDemandTarget & CodeGraphEmbeddingDemandLaneIdentity,
) {
  const rows = yield* sql.unsafe(
    `SELECT 1 FROM active_snapshots AS active JOIN snapshots AS snapshot ON snapshot.id=active.snapshot_id
    WHERE active.worktree_id=? AND active.scope_id=? AND active.snapshot_id=? AND active.activated_at=? AND snapshot.state='ready' AND snapshot.scope_id=active.scope_id
      AND NOT EXISTS (SELECT 1 FROM removed_views AS removed WHERE removed.worktree_id=active.worktree_id AND removed.scope_id=active.scope_id AND removed.expected_snapshot_id=active.snapshot_id) LIMIT 1`,
    [target.worktreeId, scopeOf(target), target.snapshotId, target.activatedAt],
  );
  return rows.length === 1;
});
/** Called only inside the promotion transaction, after the exact activation epoch is known. */
export const enqueueCodeGraphEmbeddingDemandSql = Effect.fn('codeGraph.enqueueEmbeddingDemandSql')(function* (
  sql: SqlClient.SqlClient,
  target: CodeGraphEmbeddingDemandTarget & CodeGraphEmbeddingDemandLaneIdentity,
) {
  yield* requireDemandSchema(sql, true);
  if (!(yield* targetCurrent(sql, target)))
    return yield* CodeGraphStoreError.of('Code graph embedding demand target is not current.');
  const previous = yield* readLane(sql, target);
  const next = enqueueCodeGraphEmbeddingDemandLane(previous, {...target, scopeId: scopeOf(target)});
  if (next !== previous) yield* writeLane(sql, next);
  return next;
});
export const readCodeGraphEmbeddingDemandPage = Effect.fn('codeGraph.readEmbeddingDemandPage')(function* (
  sql: SqlClient.SqlClient,
  input: {readonly after?: CodeGraphEmbeddingDemandLaneIdentity; readonly limit?: number} = {},
) {
  if (!(yield* requireDemandSchema(sql, false))) return [] as readonly CodeGraphEmbeddingDemandLane[];
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1))
    return yield* CodeGraphStoreError.of('Code graph demand page limit is invalid.');
  const limit = Math.max(
    1,
    Math.min(CODE_GRAPH_EMBEDDING_DEMAND_PAGE_SIZE, Math.floor(input.limit ?? CODE_GRAPH_EMBEDDING_DEMAND_PAGE_SIZE)),
  );
  const rows = yield* sql.unsafe<DemandRow>(
    `SELECT * FROM embedding_demand WHERE worktree_id > ? OR (worktree_id = ? AND scope_id > ?) ORDER BY worktree_id, scope_id LIMIT ?`,
    [input.after?.worktreeId ?? '', input.after?.worktreeId ?? '', input.after ? scopeOf(input.after) : '', limit],
  );
  return yield* Effect.try({
    try: () => rows.map(decodeDemand),
    catch: () => CodeGraphStoreError.of('Code graph embedding demand page is invalid.'),
  });
});
export const claimCodeGraphEmbeddingDemand = Effect.fn('codeGraph.claimEmbeddingDemand')(function* (
  sql: SqlClient.SqlClient,
  input: CodeGraphEmbeddingDemandLaneIdentity & {
    readonly owner: CodeGraphEmbeddingDemandOwner;
    readonly model: CodeGraphEmbeddingDemandModel;
    readonly now: number;
    readonly leaseMilliseconds?: number;
    /** Caller verified the exact process instance is no longer alive. */
    readonly abandonedOwnerToken?: string;
  },
) {
  yield* requireDemandSchema(sql, true);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      let lane = yield* readLane(sql, input);
      if (!lane) return undefined;
      if (input.abandonedOwnerToken !== undefined) {
        if (lane.active?.owner.token !== input.abandonedOwnerToken || input.owner.token === input.abandonedOwnerToken)
          return undefined;
        lane = {...lane, active: undefined, state: lane.state === 'building' ? 'queued' : lane.state};
      }
      if (!(yield* targetCurrent(sql, lane))) {
        yield* writeLane(sql, {...lane, state: 'cancelled', reason: 'superseded', active: undefined});
        return undefined;
      }
      const next = claimCodeGraphEmbeddingDemandLane(lane, input);
      if (!next?.active) return undefined;
      if (!validClaim(next.active))
        return yield* CodeGraphStoreError.of('Code graph embedding demand claim is invalid.');
      yield* writeLane(sql, next);
      return next.active;
    }),
  );
});
export const validateCodeGraphEmbeddingDemandClaim = Effect.fn('codeGraph.validateEmbeddingDemandClaim')(function* (
  sql: SqlClient.SqlClient,
  claim: CodeGraphEmbeddingDemandClaim,
  now: number,
) {
  yield* requireDemandSchema(sql, true);
  const lane = yield* readLane(sql, claim);
  return (
    !!lane?.active &&
    lane.active.owner.token === claim.owner.token &&
    lane.active.owner.processId === claim.owner.processId &&
    lane.active.owner.processStartIdentity === claim.owner.processStartIdentity &&
    lane.active.expiresAt > now &&
    codeGraphEmbeddingDemandSameTarget(lane, claim) &&
    codeGraphEmbeddingDemandSameTarget(lane.active, claim) &&
    codeGraphEmbeddingDemandSameModel(lane.active.model, claim.model) &&
    (yield* targetCurrent(sql, claim))
  );
});
export const acknowledgeCodeGraphEmbeddingDemand = Effect.fn('codeGraph.acknowledgeEmbeddingDemand')(function* (
  sql: SqlClient.SqlClient,
  claim: CodeGraphEmbeddingDemandClaim,
  acknowledgement: CodeGraphEmbeddingDemandAcknowledgement,
) {
  yield* requireDemandSchema(sql, true);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const lane = yield* readLane(sql, claim);
      if (!lane) return undefined;
      if (
        (acknowledgement.kind === 'checkpoint' ||
          acknowledgement.kind === 'finish' ||
          (acknowledgement.kind === 'defer' && acknowledgement.retainClaim === true)) &&
        !(yield* validateCodeGraphEmbeddingDemandClaim(sql, claim, acknowledgement.now))
      )
        return undefined;
      const next = acknowledgeCodeGraphEmbeddingDemandLane(lane, claim, acknowledgement);
      if (next) yield* writeLane(sql, next);
      return next;
    }),
  );
});
export const retryCodeGraphEmbeddingDemand = Effect.fn('codeGraph.retryEmbeddingDemand')(function* (
  sql: SqlClient.SqlClient,
  lane: CodeGraphEmbeddingDemandLaneIdentity,
  now: number,
  model?: CodeGraphEmbeddingDemandModel,
) {
  yield* requireDemandSchema(sql, true);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const current = yield* readLane(sql, lane);
      if (
        !current ||
        current.state === 'cancelled' ||
        !(yield* targetCurrent(sql, current)) ||
        (current.active && current.active.expiresAt > now)
      )
        return false;
      if (model && !validModel(model))
        return yield* CodeGraphStoreError.of('Code graph embedding demand model is invalid.');
      yield* writeLane(sql, {
        ...current,
        state: 'queued',
        attempt: 0,
        notBefore: 0,
        reason: undefined,
        active: undefined,
        ...(model ? {model} : {}),
      });
      return true;
    }),
  );
});
/** Exact removal authority cancels only existing work; it never creates a lane. */
export const cancelCodeGraphEmbeddingDemandSql = Effect.fn('codeGraph.cancelEmbeddingDemandSql')(function* (
  sql: SqlClient.SqlClient,
  input: CodeGraphEmbeddingDemandLaneIdentity & {readonly snapshotId?: string},
) {
  if (!(yield* requireDemandSchema(sql, false))) return;
  yield* sql.unsafe(
    `UPDATE embedding_demand SET state='cancelled', reason='removed', active_json=NULL WHERE worktree_id=? AND scope_id=? AND (? IS NULL OR snapshot_id=?)`,
    [input.worktreeId, scopeOf(input), input.snapshotId ?? null, input.snapshotId ?? null],
  );
});

/** Missing configuration blocks recorded intent without inventing a model or consuming a failure attempt. */
export const blockUnclaimedCodeGraphEmbeddingDemand = Effect.fn('codeGraph.blockUnclaimedEmbeddingDemand')(function* (
  sql: SqlClient.SqlClient,
  lane: CodeGraphEmbeddingDemandLaneIdentity,
  input: {readonly now: number; readonly reason: string},
) {
  yield* requireDemandSchema(sql, true);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const current = yield* readLane(sql, lane);
      if (
        !current ||
        current.state === 'cancelled' ||
        current.state === 'ready' ||
        (current.active && current.active.expiresAt > input.now)
      )
        return false;
      if (!(yield* targetCurrent(sql, current))) return false;
      yield* writeLane(sql, {
        ...current,
        state: 'blocked',
        reason: input.reason.slice(0, 512) || 'unavailable',
        active: undefined,
      });
      return true;
    }),
  );
});
