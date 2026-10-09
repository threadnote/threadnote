import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import {Clock, Duration, Effect, FileSystem, Layer, Option, PartitionedSemaphore, Path, Schema} from 'effect';
import * as PersistedQueue from 'effect/persistence/PersistedQueue';
import * as RateLimiter from 'effect/persistence/RateLimiter';
import * as SqlClient from 'effect/sql/SqlClient';
import * as Reactivity from 'effect/reactivity/Reactivity';
import {
  SourceCoordinatorError,
  SourceHttpAdmission,
  type SourceAdmissionRequest,
  type SourceWorkDescriptor,
  type SourceWorkRegistration,
  type SourceWorkResult,
} from '@threadnote/integration-core/source-coordinator';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {runtimeLstat, SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';

const fail = () =>
  SourceCoordinatorError.make({message: 'Integration coordinator is unavailable. Retry the operation.'});
const MAX_SOURCES = 1_024;
const MAX_REPLY_BYTES = 1_048_576;
const RECEIPT_RETENTION_MS = 60 * 60_000;
const Job = Schema.Struct({key: Schema.String, generation: Schema.Finite});
type QueueJob = typeof Job.Type;

export function coordinatorConcurrency(value = 2): number {
  if (!Number.isInteger(value) || value < 1 || value > 8) throw fail();
  return value;
}

async function optionalStat(filename: string) {
  try {
    return await runtimeLstat(filename);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
    throw fail();
  }
}

export type CoordinatorTicket = QueueJob;
interface JobRow {
  readonly key: string;
  readonly config_json: string;
  readonly descriptor_json: string;
  readonly generation: number;
  readonly mode: 'automatic' | 'explicit';
  readonly state: 'pending' | 'queued' | 'running' | 'idle';
  readonly not_before: number;
  readonly requested_at: number;
  readonly last_run: number;
  readonly failures: number;
}
interface ReceiptRow {
  readonly result_json: string;
  readonly failed: number;
}

export function sourceWorkKey(
  config: RuntimeConfig,
  descriptor: Pick<SourceWorkDescriptor, 'provider' | 'sourceId'>,
): string {
  return sha256HexSync(
    JSON.stringify([
      config.account,
      config.user,
      config.agentId,
      config.manifestPath,
      descriptor.provider,
      descriptor.sourceId,
    ]),
  );
}

export function sameCoordinatorIdentity(left: RuntimeConfig, right: RuntimeConfig): boolean {
  return (
    left.agentContextHome === right.agentContextHome &&
    left.account === right.account &&
    left.user === right.user &&
    left.agentId === right.agentId &&
    left.manifestPath === right.manifestPath
  );
}

/** Private canonical-home paths also hold the authenticated worker endpoint. */
export const coordinatorPaths = Effect.fn('source.coordinatorPaths')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const system = yield* SystemInfo;
  const home = yield* fs.realPath(config.agentContextHome).pipe(Effect.mapError(fail));
  const root = path.join(home, 'threadnote');
  const directory = path.join(root, 'integration-coordinator');
  for (const target of [root, directory]) {
    yield* fs.makeDirectory(target, {recursive: true, mode: 0o700}).pipe(Effect.mapError(fail));
    const stat = yield* Effect.tryPromise({try: () => runtimeLstat(target), catch: fail});
    const info = yield* fs.stat(target);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (system.platform !== 'win32' &&
        (system.userId === undefined ||
          Option.getOrUndefined(info.uid) !== system.userId ||
          (Number(stat.mode) & (target === directory ? 0o077 : 0o022)) !== 0))
    ) {
      return yield* fail();
    }
  }
  return {
    home,
    directory,
    database: path.join(directory, 'jobs.sqlite'),
    endpoint: path.join(directory, 'endpoint.json'),
    lock: path.join(directory, 'worker.lock'),
  };
});

/** Reject symlinks and shared files before SQLite or endpoint readers follow them. */
export const assertCoordinatorFile = Effect.fn('source.assertCoordinatorFile')(function* (filename: string) {
  const fs = yield* FileSystem.FileSystem;
  const system = yield* SystemInfo;
  const stat = yield* Effect.tryPromise({try: () => optionalStat(filename), catch: fail});
  if (!stat) return;
  const info = yield* fs.stat(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    Option.getOrUndefined(info.nlink) !== 1 ||
    (system.platform !== 'win32' &&
      (system.userId === undefined ||
        Option.getOrUndefined(info.uid) !== system.userId ||
        (Number(stat.mode) & 0o077) !== 0))
  ) {
    return yield* fail();
  }
});

export function validatedSourceWorkDescriptor(value: unknown): SourceWorkDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fail();
  const descriptor = value as SourceWorkDescriptor;
  if (
    typeof descriptor.sourceId !== 'string' ||
    typeof descriptor.provider !== 'string' ||
    typeof descriptor.accountKey !== 'string' ||
    typeof descriptor.fingerprint !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(descriptor.sourceId) ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(descriptor.provider) ||
    !/^[a-zA-Z0-9._:-]{1,128}$/.test(descriptor.accountKey) ||
    descriptor.fingerprint.length < 1 ||
    descriptor.fingerprint.length > 256 ||
    !Number.isFinite(descriptor.refreshIntervalMs) ||
    descriptor.refreshIntervalMs < 0 ||
    (descriptor.credentialEnv !== undefined &&
      (typeof descriptor.credentialEnv !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(descriptor.credentialEnv)))
  )
    throw fail();
  return {
    sourceId: descriptor.sourceId,
    provider: descriptor.provider,
    accountKey: descriptor.accountKey,
    fingerprint: descriptor.fingerprint,
    refreshIntervalMs: descriptor.refreshIntervalMs,
    ...(descriptor.credentialEnv === undefined ? {} : {credentialEnv: descriptor.credentialEnv}),
  };
}

export function decodeCoordinatorConfig(value: unknown, canonicalHome: string): RuntimeConfig {
  if (typeof value !== 'object' || value === null) throw fail();
  const data = value as Record<string, unknown>;
  for (const key of ['account', 'agentContextHome', 'agentId', 'manifestPath', 'user']) {
    if (typeof data[key] !== 'string' || data[key].length < 1 || data[key].length > 4_096 || /\p{Cc}/u.test(data[key]))
      throw fail();
  }
  if (data.agentContextHome !== canonicalHome) throw fail();
  return {
    account: String(data.account),
    agentContextHome: canonicalHome,
    agentId: String(data.agentId),
    manifestPath: String(data.manifestPath),
    user: String(data.user),
  };
}

function parseRow(row: JobRow) {
  return {
    config: JSON.parse(row.config_json) as RuntimeConfig,
    descriptor: validatedSourceWorkDescriptor(JSON.parse(row.descriptor_json)),
  };
}

export interface CoordinatorStore {
  readonly sql: SqlClient.SqlClient;
  readonly queue: PersistedQueue.PersistedQueue<QueueJob>;
  readonly home: string;
  readonly enqueue: (
    config: RuntimeConfig,
    descriptors: readonly SourceWorkDescriptor[],
    mode: 'automatic' | 'explicit',
  ) => Effect.Effect<readonly CoordinatorTicket[], SourceCoordinatorError>;
  readonly receipt: (
    ticket: CoordinatorTicket,
  ) => Effect.Effect<{readonly result: SourceWorkResult; readonly failed: boolean} | undefined, SourceCoordinatorError>;
  readonly pending: Effect.Effect<readonly JobRow[], SourceCoordinatorError>;
  readonly cleanup: Effect.Effect<void, SourceCoordinatorError>;
}

/** Open lazily per caller; the worker retains one scoped connection. */
export const openCoordinatorStore = Effect.fn('source.openCoordinatorStore')(function* (config: RuntimeConfig) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* coordinatorPaths(config);
  for (const filename of [paths.database, `${paths.database}-wal`, `${paths.database}-shm`])
    yield* assertCoordinatorFile(filename);
  if (!(yield* fs.exists(paths.database)))
    yield* fs
      .writeFile(paths.database, new Uint8Array(), {flag: 'wx', mode: 0o600})
      .pipe(Effect.catch(() => assertCoordinatorFile(paths.database)));
  const reactivity = yield* Reactivity.make;
  const sqlite = yield* SqliteClient.make({filename: paths.database, busyTimeout: 25}).pipe(
    Effect.provideService(Reactivity.Reactivity, reactivity),
    Effect.mapError(fail),
  );
  const sql = sqlite.withoutTransforms();
  yield* sql`CREATE TABLE IF NOT EXISTS source_jobs (
    key TEXT PRIMARY KEY, config_json TEXT NOT NULL, descriptor_json TEXT NOT NULL,
    generation INTEGER NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL,
    not_before INTEGER NOT NULL, requested_at INTEGER NOT NULL, last_run INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0
  )`.pipe(Effect.mapError(fail));
  yield* sql`CREATE TABLE IF NOT EXISTS source_receipts (
    key TEXT NOT NULL, generation INTEGER NOT NULL, result_json TEXT NOT NULL,
    failed INTEGER NOT NULL, completed_at INTEGER NOT NULL, PRIMARY KEY(key,generation)
  )`.pipe(Effect.mapError(fail));
  yield* sql`CREATE TABLE IF NOT EXISTS source_admission (
    key TEXT PRIMARY KEY, window_start INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`.pipe(Effect.mapError(fail));
  yield* sql`CREATE TABLE IF NOT EXISTS source_account_turns (key TEXT PRIMARY KEY, last_turn INTEGER NOT NULL)`.pipe(
    Effect.mapError(fail),
  );
  const queueStore = yield* PersistedQueue.makeStoreSql({
    tableName: 'source_queue',
    pollInterval: 50,
    lockRefreshInterval: 1_000,
    lockExpiration: 5_000,
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(fail));
  const factory = yield* PersistedQueue.makeFactory.pipe(
    Effect.provideService(PersistedQueue.PersistedQueueStore, queueStore),
  );
  const queue = yield* factory.make({name: 'sources-v1', schema: Job, maxAttempts: 32});
  const enqueue = (
    requestedConfig: RuntimeConfig,
    descriptors: readonly SourceWorkDescriptor[],
    mode: 'automatic' | 'explicit',
  ) =>
    Effect.gen(function* () {
      const canonicalConfig = decodeCoordinatorConfig({...requestedConfig, agentContextHome: paths.home}, paths.home);
      if (descriptors.length > MAX_SOURCES) return yield* fail();
      const now = yield* Clock.currentTimeMillis;
      const tickets: CoordinatorTicket[] = [];
      if (mode === 'automatic') {
        const desired = new Set(descriptors.map(descriptor => sourceWorkKey(canonicalConfig, descriptor)));
        const existing = yield* sql<JobRow>`SELECT * FROM source_jobs`;
        for (const row of existing)
          if (
            sameCoordinatorIdentity(JSON.parse(row.config_json) as RuntimeConfig, canonicalConfig) &&
            !desired.has(row.key)
          )
            yield* sql`DELETE FROM source_jobs WHERE key=${row.key}`;
      }
      for (const raw of descriptors) {
        const descriptor = yield* Effect.try({try: () => validatedSourceWorkDescriptor(raw), catch: fail});
        const key = sourceWorkKey(canonicalConfig, descriptor);
        const rows = yield* sql<JobRow>`SELECT * FROM source_jobs WHERE key=${key}`;
        const previous = rows[0];
        const unchanged =
          previous &&
          parseRow(previous).descriptor.fingerprint === descriptor.fingerprint &&
          parseRow(previous).descriptor.accountKey === descriptor.accountKey;
        if (previous?.state === 'running' || previous?.state === 'queued') {
          // Coalesce calls onto active work. Changed configuration must receive a
          // new generation after the active lease is released.
          if (unchanged) {
            if (mode === 'explicit' && previous.mode !== mode)
              yield* sql`UPDATE source_jobs SET mode=${mode} WHERE key=${key}`;
            tickets.push({key, generation: previous.generation});
            continue;
          }
          yield* sql`UPDATE source_jobs SET config_json=${JSON.stringify(canonicalConfig)}, descriptor_json=${JSON.stringify(descriptor)}, generation=generation+1, mode=${mode}, state='pending', not_before=${now}, requested_at=${now}, failures=0 WHERE key=${key}`;
          tickets.push({key, generation: previous.generation + 1});
          continue;
        }
        if (mode === 'automatic' && unchanged && previous.state === 'idle' && previous.not_before > now) continue;
        if (previous?.state === 'pending' && unchanged) {
          if (mode === 'explicit')
            yield* sql`UPDATE source_jobs SET mode='explicit',not_before=${now},requested_at=${now} WHERE key=${key}`;
          else yield* sql`UPDATE source_jobs SET requested_at=${now} WHERE key=${key}`;
          tickets.push({key, generation: previous.generation});
          continue;
        }
        const generation = (previous?.generation ?? 0) + 1;
        if (!previous) {
          const counts = yield* sql<{readonly count: number}>`SELECT COUNT(*) AS count FROM source_jobs`;
          if (counts[0].count >= MAX_SOURCES) return yield* fail();
        }
        yield* sql`INSERT INTO source_jobs (key,config_json,descriptor_json,generation,mode,state,not_before,requested_at,last_run,failures)
        VALUES (${key},${JSON.stringify(canonicalConfig)},${JSON.stringify(descriptor)},${generation},${mode},'pending',${mode === 'automatic' && unchanged ? Math.max(now, previous?.not_before ?? 0) : now},${now},${previous?.last_run ?? 0},0)
        ON CONFLICT(key) DO UPDATE SET config_json=excluded.config_json, descriptor_json=excluded.descriptor_json,
          generation=excluded.generation, mode=excluded.mode, state='pending', not_before=excluded.not_before, requested_at=excluded.requested_at, failures=0`;
        tickets.push({key, generation});
      }
      return tickets;
    }).pipe(sql.withTransaction, Effect.mapError(fail));
  return {
    sql,
    queue,
    home: paths.home,
    enqueue,
    receipt: (ticket: CoordinatorTicket) =>
      sql<ReceiptRow>`SELECT result_json,failed FROM source_receipts WHERE key=${ticket.key} AND generation=${ticket.generation}`.pipe(
        Effect.map(rows =>
          rows[0]
            ? {result: JSON.parse(rows[0].result_json) as SourceWorkResult, failed: rows[0].failed === 1}
            : undefined,
        ),
        Effect.mapError(fail),
      ),
    pending:
      sql<JobRow>`SELECT * FROM source_jobs WHERE state<>'idle' ORDER BY last_run,requested_at,key LIMIT ${MAX_SOURCES}`.pipe(
        Effect.mapError(fail),
      ),
    cleanup: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`DELETE FROM source_receipts WHERE completed_at < ${now - RECEIPT_RETENTION_MS}`;
      yield* sql`DELETE FROM source_receipts WHERE rowid NOT IN (SELECT rowid FROM source_receipts ORDER BY completed_at DESC LIMIT 2_048)`;
      yield* sql`DELETE FROM source_admission WHERE updated_at < ${now - 86_400_000} AND cooldown_until < ${now}`;
      yield* sql`DELETE FROM source_admission WHERE key NOT LIKE 'provider:%' AND key NOT IN (SELECT key FROM source_admission WHERE key NOT LIKE 'provider:%' ORDER BY updated_at DESC LIMIT 8_192)`;
      yield* sql`DELETE FROM source_account_turns WHERE key NOT IN (SELECT key FROM source_account_turns ORDER BY last_turn DESC LIMIT 2_048)`;
      yield* sql`DELETE FROM source_jobs WHERE state='idle' AND requested_at < ${now - 7 * 86_400_000}`;
      yield* sql`DELETE FROM source_jobs WHERE state='pending' AND requested_at < ${now - 86_400_000}`;
      yield* queueStore.cleanup({timeToLive: Duration.hours(1), failedTimeToLive: Duration.hours(1)});
      yield* sql`DELETE FROM source_queue WHERE state IN ('completed','failed') AND sequence NOT IN (SELECT sequence FROM source_queue WHERE state IN ('completed','failed') ORDER BY sequence DESC LIMIT 4_096)`;
    }).pipe(Effect.asVoid, Effect.mapError(fail)),
  } satisfies CoordinatorStore;
});

function admissionKeys(request: SourceAdmissionRequest): readonly string[] {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(request.provider) ||
    !/^[a-zA-Z0-9._:-]{1,128}$/.test(request.accountKey) ||
    !/^[A-Z][A-Z0-9_-]{0,31}$/.test(request.method)
  )
    throw fail();
  return [
    `provider:${request.provider}`,
    `account:${request.provider}:${request.accountKey}`,
    `method:${request.provider}:${request.accountKey}:${request.method}`,
  ];
}

type AdmissionPolicies = ReadonlyMap<string, {readonly limit: number; readonly windowMs: number}>;
const admissionPolicy = (provider: string, policies: AdmissionPolicies) =>
  policies.get(provider) ?? {limit: 16, windowMs: 20_000};
const accountReadyAt = (
  store: CoordinatorStore,
  descriptor: SourceWorkDescriptor,
  now: number,
  policies: AdmissionPolicies,
) =>
  Effect.gen(function* () {
    const {limit, windowMs: window} = admissionPolicy(descriptor.provider, policies);
    const rows = yield* store.sql<{
      readonly window_start: number;
      readonly used: number;
      readonly cooldown_until: number;
    }>`SELECT window_start,used,cooldown_until FROM source_admission WHERE key=${`provider:${descriptor.provider}`} OR key=${`account:${descriptor.provider}:${descriptor.accountKey}`}`;
    return Math.max(
      now,
      ...rows.map(row =>
        Math.max(
          row.cooldown_until,
          row.used >= limit && row.window_start + window > now ? row.window_start + window : now,
        ),
      ),
    );
  }).pipe(Effect.mapError(fail));

/** Shared across every HTTP caller. SQL counters survive coordinator restarts. */
export const makeSourceAdmission = Effect.fn('source.makeAdmission')(function* (
  store: CoordinatorStore,
  policies: AdmissionPolicies = new Map(),
) {
  const sql = store.sql;
  const limiterContext = yield* Layer.build(RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)));
  const limiter = yield* RateLimiter.RateLimiter.pipe(Effect.provide(limiterContext));
  const turns = yield* PartitionedSemaphore.make<string>({permits: 1});
  let waiting = 0;
  const cooldown = (request: SourceAdmissionRequest & {readonly retryAfterMs: number}) =>
    Effect.gen(function* () {
      const keys = yield* Effect.try({try: () => admissionKeys(request), catch: fail});
      const now = yield* Clock.currentTimeMillis;
      if (!Number.isFinite(request.retryAfterMs)) return yield* fail();
      const until = now + Math.min(8_640_000_000_000_000 - now - 1, Math.max(0, request.retryAfterMs));
      for (const key of keys)
        yield* sql`INSERT INTO source_admission (key,updated_at,cooldown_until) VALUES (${key},${now},${until})
      ON CONFLICT(key) DO UPDATE SET cooldown_until=MAX(cooldown_until,excluded.cooldown_until), updated_at=excluded.updated_at`;
    }).pipe(sql.withTransaction, Effect.asVoid, Effect.mapError(fail));
  const admit = (request: SourceAdmissionRequest, waitForQuota = true, onDeferred?: (until: number) => void) =>
    Effect.gen(function* () {
      const keys = yield* Effect.try({try: () => admissionKeys(request), catch: fail});
      if (waiting >= 128) return yield* fail();
      waiting++;
      const {limit, windowMs} = admissionPolicy(request.provider, policies);
      return yield* Effect.gen(function* () {
        for (;;) {
          const delay = yield* turns.withPermit(`${request.provider}:${request.accountKey}`)(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const current: {key: string; start: number; used: number}[] = [];
              let wait = 0;
              for (const key of keys) {
                const rows = yield* sql<{
                  readonly window_start: number;
                  readonly used: number;
                  readonly cooldown_until: number;
                }>`SELECT window_start,used,cooldown_until FROM source_admission WHERE key=${key}`;
                const row = rows[0];
                const start = row && now < row.window_start + windowMs ? row.window_start : now;
                const used = row && start === row.window_start ? row.used : 0;
                wait = Math.max(wait, (row?.cooldown_until ?? 0) - now, used >= limit ? start + windowMs - now : 0);
                current.push({key, start, used});
              }
              if (wait <= 0)
                for (const row of current)
                  yield* sql`INSERT INTO source_admission (key,window_start,used,updated_at) VALUES (${row.key},${row.start},${row.used + 1},${now})
            ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,used=excluded.used,updated_at=excluded.updated_at`;
              return Math.max(0, wait);
            }).pipe(sql.withTransaction, Effect.mapError(fail)),
          );
          if (delay > 0) {
            if (!waitForQuota) {
              onDeferred?.((yield* Clock.currentTimeMillis) + delay);
              return yield* fail();
            }
            yield* Effect.sleep(delay);
            continue;
          }
          // The standard Effect limiter additionally coordinates live fiber debt;
          // durable SQL reservations above remain authoritative after a restart.
          const reservation = yield* limiter
            .consume({key: keys[0], limit, window: windowMs, onExceeded: 'delay'})
            .pipe(Effect.mapError(fail));
          yield* Effect.sleep(reservation.delay);
          return;
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            waiting--;
          }),
        ),
      );
    }).pipe(Effect.mapError(fail));
  return {
    ...SourceHttpAdmission.of({admit, cooldown}),
    admitNow: (request: SourceAdmissionRequest, onDeferred: (until: number) => void) =>
      admit(request, false, onDeferred),
  };
});

export interface CoordinatorEngine {
  readonly admission: SourceHttpAdmission['Service'];
  readonly acceptCredentials: (ticket: CoordinatorTicket, values: Readonly<Record<string, string>>) => void;
  readonly acceptBinding: (
    config: RuntimeConfig,
    descriptor: SourceWorkDescriptor,
    values: Readonly<Record<string, string>>,
  ) => void;
  readonly result: (ticket: CoordinatorTicket) => SourceWorkResult | undefined;
  readonly dispatch: Effect.Effect<void, SourceCoordinatorError>;
  readonly consume: Effect.Effect<void, SourceCoordinatorError>;
  readonly activeCount: () => number;
}

export const makeCoordinatorEngine = Effect.fn('source.makeCoordinatorEngine')(function* <R>(options: {
  readonly store: CoordinatorStore;
  readonly registrations: readonly SourceWorkRegistration<R>[];
  readonly quantumTimeoutMs?: number;
  readonly maxConcurrentSources?: number;
}) {
  const {store} = options;
  const sql = store.sql;
  const system = yield* SystemInfo;
  const clock = yield* Clock.Clock;
  const context = yield* Effect.context<R>();
  const policies = new Map(
    options.registrations.flatMap(registration =>
      registration.admission ? [[registration.provider, registration.admission] as const] : [],
    ),
  );
  if (
    [...policies.values()].some(
      policy =>
        !Number.isInteger(policy.limit) ||
        policy.limit < 1 ||
        policy.limit > 1_000 ||
        !Number.isFinite(policy.windowMs) ||
        policy.windowMs < 1 ||
        policy.windowMs > 86_400_000,
    )
  )
    return yield* fail();
  const admission = yield* makeSourceAdmission(store, policies);
  const registrations = new Map(options.registrations.map(registration => [registration.provider, registration]));
  if (registrations.size !== options.registrations.length) return yield* fail();
  const credentials = new Map<string, {values: Readonly<Record<string, string>>; at: number}>();
  const sourceCredentials = new Map<
    string,
    {sourceKey: string; values: Readonly<Record<string, string>>; fingerprint: string; accountKey: string; at: number}
  >();
  const receivedSources = new Set<string>();
  const results = new Map<string, {result: SourceWorkResult; at: number}>();
  const active = new Map<string, SourceWorkDescriptor>();
  const reserved = new Map<string, {descriptor: SourceWorkDescriptor; generation: number}>();
  const concurrency = yield* Effect.try({try: () => coordinatorConcurrency(options.maxConcurrentSources), catch: fail});
  if (
    options.quantumTimeoutMs !== undefined &&
    (!Number.isFinite(options.quantumTimeoutMs) || options.quantumTimeoutMs <= 0)
  )
    return yield* fail();
  const turns = yield* PartitionedSemaphore.make<string>({permits: concurrency});
  const id = (ticket: CoordinatorTicket) => `${ticket.key}:${ticket.generation}`;
  const bindingId = (sourceKey: string, descriptor: SourceWorkDescriptor) =>
    JSON.stringify([sourceKey, descriptor.fingerprint, descriptor.accountKey]);
  // The enclosing singleton lock proves the preceding worker is gone. Queue
  // leases themselves still expire normally before at-least-once redelivery.
  yield* sql`UPDATE source_jobs SET state='pending' WHERE state IN ('queued','running')`.pipe(Effect.mapError(fail));
  const bounded = <A>(map: Map<string, A>, limit = 64) => {
    while (map.size > limit) map.delete(map.keys().next().value!);
  };
  const dispatch = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    // A finite queue crash limit cannot strand authoritative desired work.
    yield* sql`UPDATE source_jobs SET state='pending',generation=generation+1 WHERE state IN ('queued','running') AND EXISTS
      (SELECT 1 FROM source_queue WHERE source_queue.id=source_jobs.key || ':' || source_jobs.generation AND source_queue.state='failed')`;
    const pending = [...(yield* store.pending)];
    const accountTurns = new Map(
      (yield* sql<{
        readonly key: string;
        readonly last_turn: number;
      }>`SELECT key,last_turn FROM source_account_turns`).map(row => [row.key, row.last_turn]),
    );
    pending.sort((left, right) => {
      const a = parseRow(left).descriptor;
      const b = parseRow(right).descriptor;
      return (
        (accountTurns.get(`${a.provider}:${a.accountKey}`) ?? 0) -
          (accountTurns.get(`${b.provider}:${b.accountKey}`) ?? 0) ||
        left.last_run - right.last_run ||
        left.requested_at - right.requested_at ||
        left.key.localeCompare(right.key)
      );
    });
    const occupied = [...active.values(), ...[...reserved.values()].map(value => value.descriptor)];
    const accounts = new Set(occupied.map(value => `${value.provider}:${value.accountKey}`));
    const sources = new Set(occupied.map(value => `${value.provider}:${value.sourceId}`));
    for (const row of pending) {
      if (active.size + reserved.size >= concurrency) break;
      if (row.state !== 'pending' || row.not_before > now || active.has(row.key) || reserved.has(row.key)) continue;
      const {descriptor} = parseRow(row);
      const account = `${descriptor.provider}:${descriptor.accountKey}`;
      const source = `${descriptor.provider}:${descriptor.sourceId}`;
      if (accounts.has(account) || sources.has(source)) continue;
      const readyAt = yield* accountReadyAt(store, descriptor, now, policies);
      if (readyAt > now) {
        yield* sql`UPDATE source_jobs SET not_before=MAX(not_before,${readyAt}) WHERE key=${row.key} AND generation=${row.generation} AND state='pending'`;
        continue;
      }
      yield* Effect.gen(function* () {
        const changed = yield* sql<{
          readonly key: string;
        }>`UPDATE source_jobs SET state='queued' WHERE key=${row.key} AND generation=${row.generation} AND state='pending' RETURNING key`;
        if (changed.length === 0) return;
        yield* store.queue.offer({key: row.key, generation: row.generation}, {id: id(row)});
        const turn = Math.max(now, ...accountTurns.values()) + 1;
        yield* sql`INSERT INTO source_account_turns (key,last_turn) VALUES (${account},${turn}) ON CONFLICT(key) DO UPDATE SET last_turn=excluded.last_turn`;
        accountTurns.set(account, turn);
        reserved.set(row.key, {descriptor, generation: row.generation});
        accounts.add(account);
        sources.add(source);
      }).pipe(sql.withTransaction, Effect.mapError(fail));
    }
  }).pipe(Effect.mapError(fail));
  const consume = store.queue
    .take(ticket =>
      Effect.gen(function* () {
        const rows = yield* sql<JobRow>`SELECT * FROM source_jobs WHERE key=${ticket.key}`;
        const row = rows[0];
        if (!row || row.generation !== ticket.generation || row.state === 'idle') {
          if (reserved.get(ticket.key)?.generation === ticket.generation) reserved.delete(ticket.key);
          return;
        }
        const {config, descriptor} = parseRow(row);
        const readyAt = yield* accountReadyAt(store, descriptor, yield* Clock.currentTimeMillis, policies);
        if (readyAt > (yield* Clock.currentTimeMillis)) {
          yield* sql`UPDATE source_jobs SET state='pending',generation=generation+1,not_before=MAX(not_before,${readyAt}) WHERE key=${ticket.key} AND generation=${ticket.generation}`;
          reserved.delete(ticket.key);
          return;
        }
        reserved.delete(ticket.key);
        active.set(ticket.key, descriptor);
        const run = Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          yield* sql`UPDATE source_jobs SET state='running',last_run=${startedAt} WHERE key=${ticket.key} AND generation=${ticket.generation}`;
          const registration = registrations.get(descriptor.provider);
          const credentialKey = bindingId(ticket.key, descriptor);
          const remembered = sourceCredentials.get(credentialKey);
          const supplied = credentials.get(id(ticket))?.values;
          if (supplied !== undefined) {
            sourceCredentials.set(credentialKey, {
              sourceKey: ticket.key,
              values: supplied,
              fingerprint: descriptor.fingerprint,
              accountKey: descriptor.accountKey,
              at: startedAt,
            });
            receivedSources.add(credentialKey);
            bounded(sourceCredentials, MAX_SOURCES);
          }
          const values =
            supplied ??
            (remembered?.fingerprint === descriptor.fingerprint && remembered.accountKey === descriptor.accountKey
              ? remembered.values
              : receivedSources.has(credentialKey)
                ? {}
                : Object.fromEntries(
                    descriptor.credentialEnv && system.environment()[descriptor.credentialEnv] !== undefined
                      ? [[descriptor.credentialEnv, system.environment()[descriptor.credentialEnv]!]]
                      : [],
                  ));
          const environment = {...system.environment()};
          if (descriptor.credentialEnv) {
            delete environment[descriptor.credentialEnv];
            if (values[descriptor.credentialEnv] !== undefined)
              environment[descriptor.credentialEnv] = values[descriptor.credentialEnv];
          }
          let deferredUntil = 0;
          const workAdmission = SourceHttpAdmission.of({
            admit: request =>
              admission.admitNow(request, until => {
                deferredUntil = Math.max(deferredUntil, until);
              }),
            cooldown: admission.cooldown,
          });
          const work = Effect.gen(function* () {
            if (!registration) return yield* fail();
            const fresh = yield* registration.list(config);
            if (
              !fresh.some(
                value =>
                  value.sourceId === descriptor.sourceId &&
                  value.fingerprint === descriptor.fingerprint &&
                  value.accountKey === descriptor.accountKey,
              )
            )
              return yield* fail();
            // Retention slides only after the authoritative identity fence.
            const binding = sourceCredentials.get(credentialKey);
            if (binding) binding.at = yield* Clock.currentTimeMillis;
            return yield* registration.run(config, descriptor.sourceId, {
              mode: row.mode,
              requestId: id(ticket),
              credentialEnvironment: values,
            });
          }).pipe(
            Effect.provideService(SystemInfo, {...system, environment: () => environment}),
            Effect.provideService(SourceHttpAdmission, workAdmission),
            Effect.provide(context),
            Effect.timeout(options.quantumTimeoutMs ?? 30_000),
          );
          const outcome = yield* work.pipe(Effect.result);
          const now = yield* Clock.currentTimeMillis;
          const succeeded = outcome._tag === 'Success';
          const result: SourceWorkResult = succeeded
            ? outcome.success
            : {
                sourceId: descriptor.sourceId,
                syncedDocuments: [],
                warnings: ['Source refresh failed. Retry explicit sync for details.'],
              };
          // Do not persist provider values, Console output, fetched text, or errors.
          const receipt: SourceWorkResult = {
            sourceId: descriptor.sourceId,
            syncedDocuments: result.syncedDocuments.slice(0, 1_024).map(value => value.slice(0, 512)),
            warnings: result.warnings.length ? [`Source refresh reported ${result.warnings.length} warning(s).`] : [],
            ...(result.nextAttemptAt !== undefined ? {nextAttemptAt: result.nextAttemptAt} : {}),
            ...(result.more ? {more: true} : {}),
          };
          const reply = yield* Effect.try({try: () => JSON.stringify(result), catch: fail}).pipe(
            Effect.orElseSucceed(() => undefined),
          );
          if (reply !== undefined && new TextEncoder().encode(reply).byteLength <= MAX_REPLY_BYTES) {
            results.set(id(ticket), {result, at: now});
            bounded(results);
          }
          const retry = !succeeded || result.more === true || deferredUntil > now;
          const failures = succeeded ? 0 : Math.min(20, row.failures + 1);
          const next = Math.max(
            now +
              (succeeded
                ? result.more || deferredUntil > now
                  ? 0
                  : Math.max(1_000, descriptor.refreshIntervalMs)
                : Math.min(300_000, 1_000 * 2 ** failures)),
            result.nextAttemptAt ?? 0,
            deferredUntil,
          );
          yield* Effect.gen(function* () {
            yield* sql`INSERT OR REPLACE INTO source_receipts (key,generation,result_json,failed,completed_at) VALUES (${ticket.key},${ticket.generation},${JSON.stringify(receipt)},${succeeded ? 0 : 1},${now})`;
            yield* sql`UPDATE source_jobs SET state=${retry ? 'pending' : 'idle'},generation=${retry ? ticket.generation + 1 : ticket.generation},not_before=${next},failures=${failures}
          WHERE key=${ticket.key} AND generation=${ticket.generation}`;
          }).pipe(sql.withTransaction);
          credentials.delete(id(ticket));
          for (const [key, value] of results) if (value.at < now - 5 * 60_000) results.delete(key);
          for (const [key, value] of credentials) if (value.at < now - 5 * 60_000) credentials.delete(key);
          const outstanding = new Set((yield* store.pending).map(value => value.key));
          for (const [key, value] of sourceCredentials)
            if (!outstanding.has(value.sourceKey) && value.at < now - 5 * 60_000) sourceCredentials.delete(key);
        });
        return yield* turns
          .withPermit(`${descriptor.provider}:${descriptor.accountKey}`)(run)
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active.delete(ticket.key);
              }),
            ),
            Effect.mapError(fail),
          );
      }).pipe(Effect.mapError(fail)),
    )
    .pipe(Effect.asVoid, Effect.mapError(fail));
  return {
    admission,
    dispatch,
    consume,
    acceptCredentials: (ticket: CoordinatorTicket, values: Readonly<Record<string, string>>) => {
      credentials.set(id(ticket), {values, at: clock.currentTimeMillisUnsafe()});
      bounded(credentials, MAX_SOURCES);
    },
    acceptBinding: (
      config: RuntimeConfig,
      descriptor: SourceWorkDescriptor,
      values: Readonly<Record<string, string>>,
    ) => {
      const key = sourceWorkKey(config, descriptor);
      const credentialKey = bindingId(key, descriptor);
      sourceCredentials.set(credentialKey, {
        sourceKey: key,
        values,
        fingerprint: descriptor.fingerprint,
        accountKey: descriptor.accountKey,
        at: clock.currentTimeMillisUnsafe(),
      });
      receivedSources.add(credentialKey);
      bounded(sourceCredentials, MAX_SOURCES);
      while (receivedSources.size > MAX_SOURCES) receivedSources.delete(receivedSources.values().next().value!);
    },
    result: (ticket: CoordinatorTicket) => results.get(id(ticket))?.result,
    activeCount: () => active.size + reserved.size,
  } satisfies CoordinatorEngine;
});
