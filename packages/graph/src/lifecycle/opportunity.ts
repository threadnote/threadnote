import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient';
import * as SqlClient from 'effect/sql/SqlClient';
import {runtimeOpenTextDirectoryNameReader} from '@threadnote/platform/system';
import {hasCodeGraphEmbeddingDemand} from '../vector/demand.js';
import {CodeGraphEmbeddingWorkerProcess} from '../runtime_ports.js';
import {codeGraphRepositoriesRoot} from '../layout.js';
import {Effect, FileSystem, Layer, Option, Path, Predicate, Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {syncDirectoryBestEffort, syncWritableFile} from '@threadnote/platform/file/durability';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {codeGraphDatabaseWriteLockPath, codeGraphLayout} from '../layout.js';
import {readCodeGraphLocalAssociation} from '../local_provenance.js';
import {codeGraphDatabasePaths} from '../maintenance.js';
import {type CodeGraphMaintenanceCoordinatorShape} from '../maintenance/coordinator.js';
import {compareCodeUnits} from '../ordering.js';
import {inspectCodeGraphStorage} from '../storage.js';
import {codeGraphStorageAccounting, type CodeGraphStoragePressure} from '../storage/pressure.js';
import {CodeGraphStore} from '../store.js';
import {type CodeGraphRoutineMaintenanceResult} from '../store/models.js';
import {type RepositoryIdentity} from '../types.js';

export const CODE_GRAPH_LIFECYCLE_OPPORTUNITIES = [
  'startup',
  'catalog',
  'diagnostics',
  'status',
  'index-completion',
  'critical-error',
] as const;

export type CodeGraphLifecycleOpportunity = (typeof CODE_GRAPH_LIFECYCLE_OPPORTUNITIES)[number];

export interface CodeGraphLifecycleOpportunityTarget {
  readonly anchorIdentity?: RepositoryIdentity;
  /** Trusted local path used only to re-resolve a live anchor; never returned. */
  readonly anchorPath?: string;
  readonly checkoutId: string;
  readonly databasePath: string;
  readonly pressure?: Extract<CodeGraphStoragePressure, 'critical' | 'elevated'>;
  /** Path-free signal used by long-lived status polling to keep reconciliation cadence responsive. */
  readonly reconciliationPending?: boolean;
}

export type CodeGraphLifecycleOpportunityResult =
  | {readonly opportunity: CodeGraphLifecycleOpportunity; readonly state: 'no-target'}
  | {
      readonly opportunity: CodeGraphLifecycleOpportunity;
      readonly reason: 'deadline';
      readonly state: 'deferred';
    }
  | {
      readonly checkoutId: string;
      readonly opportunity: CodeGraphLifecycleOpportunity;
      readonly result: CodeGraphRoutineMaintenanceResult;
      readonly state: 'completed';
    };

const LIFECYCLE_OPPORTUNITY_CURSOR_LIMIT = 128;
export const CODE_GRAPH_LIFECYCLE_OPPORTUNITY_UNIT_MILLISECONDS = 2_000;
const LIFECYCLE_OPPORTUNITY_CURSOR_BYTES_LIMIT = 512;
const LIFECYCLE_OPPORTUNITY_CURSOR_SCHEMA_VERSION = 1 as const;
const LIFECYCLE_OPPORTUNITY_CURSOR_LOCK_OPTIONS = {
  retryIntervalMilliseconds: 10,
  staleAfterMilliseconds: 120_000,
  waitTimeoutMilliseconds: 0,
} as const;

interface PersistedLifecycleOpportunityCursor {
  readonly checkoutId: string;
  readonly databasePathDigest: string;
  readonly lane: CodeGraphLifecycleOpportunityUnitLane;
  readonly schemaVersion: typeof LIFECYCLE_OPPORTUNITY_CURSOR_SCHEMA_VERSION;
}

export type CodeGraphLifecycleOpportunityUnitLane = 'ordinary' | 'reconciliation' | 'residual' | 'rotating';

export interface CodeGraphLifecycleOpportunityUnit {
  readonly lane: CodeGraphLifecycleOpportunityUnitLane;
  readonly target: CodeGraphLifecycleOpportunityTarget;
}

class CodeGraphLifecycleOpportunityCursorError extends Schema.TaggedError<CodeGraphLifecycleOpportunityCursorError>()(
  'CodeGraphLifecycleOpportunityCursorError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

/** Read bounded active-pointer provenance without invoking Git on the healthy hot path. */
export const observeCodeGraphLifecycleOpportunityTargets = Effect.fn('codeGraph.observeLifecycleOpportunityTargets')(
  function* (threadnoteHome: string) {
    const path = yield* Path.Path;
    const store = yield* CodeGraphStore;
    const databases = yield* codeGraphDatabasePaths(threadnoteHome);
    return yield* Effect.forEach(
      databases,
      databasePath =>
        Effect.gen(function* () {
          const checkoutId = path.basename(path.dirname(databasePath));
          const [views, storage] = yield* Effect.all(
            [
              store.loadActiveViewIdentities(databasePath, 8).pipe(Effect.orElseSucceed(() => [])),
              inspectCodeGraphStorage(threadnoteHome, checkoutId).pipe(Effect.orElseSucceed(() => undefined)),
            ],
            {concurrency: 2},
          );
          const associations = yield* Effect.forEach(
            views,
            view =>
              readCodeGraphLocalAssociation(threadnoteHome, {
                checkoutId,
                repositoryId: view.repositoryId,
                worktreeId: view.worktreeId,
              }),
            {concurrency: 1},
          );
          const anchor = associations.find(association => association.state === 'verified' && 'path' in association);
          const anchorPath = anchor !== undefined && 'path' in anchor ? anchor.path : undefined;
          const pressure = storage?.state === 'available' ? codeGraphStorageAccounting(storage).pressure : undefined;
          return {
            ...(anchorPath === undefined ? {} : {anchorPath}),
            checkoutId,
            databasePath,
            ...(pressure === 'critical' || pressure === 'elevated' ? {pressure} : {}),
            reconciliationPending: associations.some(association => association.state === 'missing'),
          } satisfies CodeGraphLifecycleOpportunityTarget;
        }),
      {concurrency: 2},
    );
  },
);

/**
 * Await one zero-wait maintenance unit at a foreground lifecycle opportunity.
 * Pending cleanup and explicit diagnostics durably rotate database-by-lane;
 * healthy hot paths retain their in-process target rotation without cursor I/O.
 * A short-lived CLI therefore commits one bounded unit before exit.
 */
export function makeCodeGraphLifecycleOpportunityRunner() {
  const opportunityCursors = new Map<string, string>();
  return Effect.fn('codeGraph.runLifecycleOpportunity')(function* (input: {
    readonly maintenance: CodeGraphMaintenanceCoordinatorShape;
    readonly opportunity: CodeGraphLifecycleOpportunity;
    readonly pressure?: Extract<CodeGraphStoragePressure, 'critical' | 'elevated'>;
    readonly targets: readonly CodeGraphLifecycleOpportunityTarget[];
    readonly threadnoteHome: string;
  }) {
    const path = yield* Path.Path;
    const cursorKey = `${input.threadnoteHome}\0${input.opportunity}`;
    const memoryCursor = opportunityCursors.get(cursorKey);
    const units = codeGraphLifecycleOpportunityUnits(input.targets, input.opportunity);
    const persistentRotation = units.some(unit => unit.lane === 'reconciliation');
    const unit = persistentRotation
      ? yield* claimPersistedLifecycleOpportunityUnit({...input, units}).pipe(
          Effect.catch(() => Effect.sync(() => selectCodeGraphLifecycleOpportunityUnit(units, memoryCursor))),
        )
      : selectCodeGraphLifecycleOpportunityUnit(units, memoryCursor);
    if (unit === undefined) return {opportunity: input.opportunity, state: 'no-target'} as const;
    rememberOpportunityCursor(opportunityCursors, cursorKey, lifecycleOpportunityUnitKey(unit));
    const target = unit.target;

    let anchorIdentity = target.anchorIdentity;
    if (anchorIdentity !== undefined) {
      const layout = codeGraphLayout(path, input.threadnoteHome, anchorIdentity.checkoutId, anchorIdentity.worktreeId);
      if (anchorIdentity.checkoutId !== target.checkoutId || layout.databasePath !== target.databasePath) {
        anchorIdentity = undefined;
      }
    }
    const pressure = target.pressure ?? input.pressure;
    const tick = {
      ...(anchorIdentity === undefined ? {} : {allowIndexPreparation: true as const, anchorIdentity}),
      ...(anchorIdentity === undefined && target.anchorPath !== undefined
        ? {allowIndexPreparation: true as const, anchorPath: target.anchorPath}
        : {}),
      automaticTail: false,
      checkoutId: target.checkoutId,
      databasePath: target.databasePath,
      joinActive: false,
      ...(pressure === undefined ? {} : {pressure}),
      threadnoteHome: input.threadnoteHome,
      writerLockPath: codeGraphDatabaseWriteLockPath(path, input.threadnoteHome, target.checkoutId),
    } as const;
    const observed = yield* (
      unit.lane === 'ordinary'
        ? input.maintenance.kickOrdinary(tick)
        : unit.lane === 'reconciliation'
          ? input.maintenance.kickReconciliation(tick)
          : unit.lane === 'residual'
            ? input.maintenance.kickResidual(tick)
            : input.maintenance.tick(tick)
    ).pipe(Effect.timeoutOption(CODE_GRAPH_LIFECYCLE_OPPORTUNITY_UNIT_MILLISECONDS));
    if (Option.isNone(observed)) {
      return {opportunity: input.opportunity, reason: 'deadline', state: 'deferred'} as const;
    }
    return {
      checkoutId: target.checkoutId,
      opportunity: input.opportunity,
      result: observed.value,
      state: 'completed',
    } as const;
  });
}

export const runCodeGraphLifecycleOpportunity = makeCodeGraphLifecycleOpportunityRunner();

/** @internal Pure round-robin selector retained for fairness properties. */
export function selectCodeGraphLifecycleOpportunityTarget(
  targets: readonly CodeGraphLifecycleOpportunityTarget[],
  cursor?: string,
): CodeGraphLifecycleOpportunityTarget | undefined {
  const unique = new Map<string, CodeGraphLifecycleOpportunityTarget>();
  for (const target of targets) {
    if (/^[0-9a-f]{64}$/u.test(target.checkoutId) && target.databasePath.length > 0) {
      unique.set(lifecycleTargetKey(target), target);
    }
  }
  const ordered = [...unique.entries()].sort(([left], [right]) => compareCodeUnits(left, right));
  if (ordered.length === 0) return undefined;
  if (cursor === undefined) {
    return (ordered.find(
      ([, target]) =>
        target.reconciliationPending === true &&
        (target.anchorIdentity !== undefined || target.anchorPath !== undefined),
    ) ?? ordered[0])[1];
  }
  return (ordered.find(([key]) => compareCodeUnits(key, cursor) > 0) ?? ordered[0])[1];
}

/** @internal Plan one deterministic bounded ring without deriving deletion authority. */
export function codeGraphLifecycleOpportunityUnits(
  targets: readonly CodeGraphLifecycleOpportunityTarget[],
  opportunity: CodeGraphLifecycleOpportunity,
): readonly CodeGraphLifecycleOpportunityUnit[] {
  const ordered = orderedCodeGraphLifecycleOpportunityTargets(targets);
  if (opportunity === 'index-completion') {
    return ordered.map(target => ({lane: 'ordinary', target}));
  }
  const reconciliation = ordered.filter(
    target =>
      (opportunity === 'diagnostics' || target.reconciliationPending === true) &&
      (target.anchorIdentity !== undefined || target.anchorPath !== undefined),
  );
  if (reconciliation.length === 0) return ordered.map(target => ({lane: 'rotating', target}));
  return [
    ...reconciliation.map(target => ({lane: 'reconciliation' as const, target})),
    ...ordered.map(target => ({lane: 'ordinary' as const, target})),
    ...ordered.map(target => ({lane: 'residual' as const, target})),
  ];
}

/** @internal Pure round-robin unit selector retained for fairness properties. */
export function selectCodeGraphLifecycleOpportunityUnit(
  units: readonly CodeGraphLifecycleOpportunityUnit[],
  cursor?: string,
): CodeGraphLifecycleOpportunityUnit | undefined {
  if (units.length === 0) return undefined;
  if (cursor === undefined) return units[0];
  const cursorIndex = units.findIndex(unit => lifecycleOpportunityUnitKey(unit) === cursor);
  return cursorIndex < 0 ? units[0] : units[(cursorIndex + 1) % units.length];
}

function lifecycleTargetKey(target: CodeGraphLifecycleOpportunityTarget): string {
  return `${target.checkoutId}\0${target.databasePath}`;
}

function lifecycleOpportunityUnitKey(unit: CodeGraphLifecycleOpportunityUnit): string {
  return `${unit.lane}\0${lifecycleTargetKey(unit.target)}`;
}

function orderedCodeGraphLifecycleOpportunityTargets(
  targets: readonly CodeGraphLifecycleOpportunityTarget[],
): readonly CodeGraphLifecycleOpportunityTarget[] {
  const unique = new Map<string, CodeGraphLifecycleOpportunityTarget>();
  for (const target of targets) {
    if (/^[0-9a-f]{64}$/u.test(target.checkoutId) && target.databasePath.length > 0) {
      unique.set(lifecycleTargetKey(target), target);
    }
  }
  return [...unique.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([, target]) => target);
}

const claimPersistedLifecycleOpportunityUnit = Effect.fn('codeGraph.claimLifecycleOpportunityUnit')(function* (input: {
  readonly opportunity: CodeGraphLifecycleOpportunity;
  readonly threadnoteHome: string;
  readonly units: readonly CodeGraphLifecycleOpportunityUnit[];
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(input.threadnoteHome, 'locks', 'indexes', 'code-graph', 'lifecycle-opportunities');
  const cursorPath = path.join(root, `${input.opportunity}.cursor-v1.json`);
  const lockPath = path.join(root, `${input.opportunity}.cursor.lock`);
  return yield* withExclusiveFileLock(
    fs,
    lockPath,
    LIFECYCLE_OPPORTUNITY_CURSOR_LOCK_OPTIONS,
    Effect.gen(function* () {
      const persisted = yield* readPersistedLifecycleOpportunityCursor(fs, cursorPath);
      const cursor = persistedLifecycleOpportunityUnitKey(input.units, persisted);
      const selected = selectCodeGraphLifecycleOpportunityUnit(input.units, cursor);
      if (selected === undefined) return undefined;
      yield* writePersistedLifecycleOpportunityCursor(fs, path, root, cursorPath, {
        checkoutId: selected.target.checkoutId,
        databasePathDigest: sha256HexSync(selected.target.databasePath),
        lane: selected.lane,
        schemaVersion: LIFECYCLE_OPPORTUNITY_CURSOR_SCHEMA_VERSION,
      });
      return selected;
    }),
  );
});

function readPersistedLifecycleOpportunityCursor(
  fs: FileSystem.FileSystem,
  cursorPath: string,
): Effect.Effect<PersistedLifecycleOpportunityCursor | undefined, CodeGraphLifecycleOpportunityCursorError> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(cursorPath))) return undefined;
    if (Option.isSome(yield* fs.readLink(cursorPath).pipe(Effect.option))) {
      return yield* CodeGraphLifecycleOpportunityCursorError.make({message: 'Lifecycle cursor is not a file.'});
    }
    const info = yield* fs.stat(cursorPath);
    if (info.type !== 'File' || Number(info.size) > LIFECYCLE_OPPORTUNITY_CURSOR_BYTES_LIMIT) return undefined;
    const content = yield* fs.readFileString(cursorPath);
    if (new TextEncoder().encode(content).byteLength > LIFECYCLE_OPPORTUNITY_CURSOR_BYTES_LIMIT) return undefined;
    return decodePersistedLifecycleOpportunityCursor(content);
  }).pipe(
    Effect.mapError(() => CodeGraphLifecycleOpportunityCursorError.make({message: 'Could not read lifecycle cursor.'})),
  );
}

const writePersistedLifecycleOpportunityCursor = Effect.fn('codeGraph.writeLifecycleOpportunityCursor')(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  cursorPath: string,
  cursor: PersistedLifecycleOpportunityCursor,
) {
  if (Option.isSome(yield* fs.readLink(cursorPath).pipe(Effect.option))) {
    return yield* CodeGraphLifecycleOpportunityCursorError.make({message: 'Lifecycle cursor is not a file.'});
  }
  const content = `${JSON.stringify(cursor)}\n`;
  if (new TextEncoder().encode(content).byteLength > LIFECYCLE_OPPORTUNITY_CURSOR_BYTES_LIMIT) {
    return yield* CodeGraphLifecycleOpportunityCursorError.make({message: 'Lifecycle cursor is too large.'});
  }
  const temporary = path.join(root, `.${path.basename(cursorPath)}.tmp`);
  yield* Effect.gen(function* () {
    // The opportunity lock gives this publication path a single writer. Reuse
    // one deterministic temporary so a hard crash can strand at most one file,
    // and the next claim recovers it before publishing.
    yield* fs.remove(temporary, {force: true});
    yield* fs.writeFileString(temporary, content, {flag: 'wx', mode: 0o600});
    yield* syncWritableFile(fs, temporary);
    if (Option.isSome(yield* fs.readLink(cursorPath).pipe(Effect.option))) {
      return yield* CodeGraphLifecycleOpportunityCursorError.make({message: 'Lifecycle cursor changed type.'});
    }
    yield* fs.rename(temporary, cursorPath);
    yield* syncDirectoryBestEffort(fs, root);
  }).pipe(Effect.ensuring(fs.remove(temporary, {force: true}).pipe(Effect.ignore)));
});

function decodePersistedLifecycleOpportunityCursor(content: string): PersistedLifecycleOpportunityCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!Predicate.isObject(parsed)) return undefined;
    if (
      parsed.schemaVersion !== LIFECYCLE_OPPORTUNITY_CURSOR_SCHEMA_VERSION ||
      typeof parsed.checkoutId !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(parsed.checkoutId) ||
      typeof parsed.databasePathDigest !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(parsed.databasePathDigest) ||
      !isCodeGraphLifecycleOpportunityUnitLane(parsed.lane)
    ) {
      return undefined;
    }
    return {
      checkoutId: parsed.checkoutId,
      databasePathDigest: parsed.databasePathDigest,
      lane: parsed.lane,
      schemaVersion: LIFECYCLE_OPPORTUNITY_CURSOR_SCHEMA_VERSION,
    };
  } catch {
    return undefined;
  }
}

function persistedLifecycleOpportunityUnitKey(
  units: readonly CodeGraphLifecycleOpportunityUnit[],
  cursor: PersistedLifecycleOpportunityCursor | undefined,
): string | undefined {
  if (cursor === undefined) return undefined;
  const unit = units.find(
    candidate =>
      candidate.lane === cursor.lane &&
      candidate.target.checkoutId === cursor.checkoutId &&
      sha256HexSync(candidate.target.databasePath) === cursor.databasePathDigest,
  );
  return unit === undefined ? undefined : lifecycleOpportunityUnitKey(unit);
}

function isCodeGraphLifecycleOpportunityUnitLane(value: unknown): value is CodeGraphLifecycleOpportunityUnitLane {
  return value === 'ordinary' || value === 'reconciliation' || value === 'residual' || value === 'rotating';
}

function rememberOpportunityCursor(cursors: Map<string, string>, key: string, cursor: string): void {
  cursors.delete(key);
  cursors.set(key, cursor);
  while (cursors.size > LIFECYCLE_OPPORTUNITY_CURSOR_LIMIT) {
    const oldest = cursors.keys().next().value;
    if (oldest === undefined) break;
    cursors.delete(oldest);
  }
}

/** Dedicated metadata connection: native SQLite lock waits must fit inside the optional probe budget. */
const readExistingEmbeddingDemandCatalog = (databasePath: string) =>
  Effect.scoped(
    Layer.build(
      SqliteClient.layer({
        filename: databasePath,
        readonly: true,
        readwrite: false,
        create: false,
        disableWAL: true,
        busyTimeout: 50,
      }),
    ).pipe(
      Effect.flatMap(context =>
        Effect.flatMap(SqlClient.SqlClient, hasCodeGraphEmbeddingDemand).pipe(Effect.provide(context)),
      ),
    ),
  );

/** Startup may resume recorded work, but never discover views to enqueue new work. */
export const resumeExistingCodeGraphEmbeddingDemand = Effect.fn('codeGraph.resumeExistingEmbeddingDemand')(function* (
  threadnoteHome: string,
  options: {
    /** @internal Directory lifetime seam for interruption and catalog-order tests. */
    readonly openDirectory?: typeof runtimeOpenTextDirectoryNameReader;
    /** @internal Metadata-read lifetime seam; production always uses the dedicated read-only client. */
    readonly beforeReadCatalog?: (databasePath: string) => Effect.Effect<void>;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const worker = yield* Effect.serviceOption(CodeGraphEmbeddingWorkerProcess);
  if (Option.isNone(worker)) return false;
  const repositories = codeGraphRepositoriesRoot(path, threadnoteHome);
  const probe = Effect.acquireUseRelease(
    Effect.tryPromise(() => (options.openDirectory ?? runtimeOpenTextDirectoryNameReader)(repositories)),
    directory =>
      Effect.gen(function* () {
        if (Option.isSome(yield* fs.readLink(repositories).pipe(Effect.option))) return false;
        do {
          const page = yield* Effect.tryPromise(() => directory.readPage(64));
          for (const checkoutId of page.names) {
            if (!/^[a-f0-9]{64}$/u.test(checkoutId)) continue;
            const pending = yield* Effect.gen(function* () {
              const layout = codeGraphLayout(path, threadnoteHome, checkoutId, '0'.repeat(64));
              if (Option.isSome(yield* fs.readLink(layout.repositoryRoot).pipe(Effect.option))) return false;
              if (Option.isSome(yield* fs.readLink(layout.databasePath).pipe(Effect.option))) return false;
              if (!(yield* fs.exists(layout.databasePath))) return false;
              yield* options.beforeReadCatalog?.(layout.databasePath) ?? Effect.void;
              return yield* readExistingEmbeddingDemandCatalog(layout.databasePath);
            }).pipe(
              Effect.catchTags({
                SqlError: () => Effect.succeed(false),
                CodeGraphStoreError: () => Effect.succeed(false),
                PlatformError: () => Effect.succeed(false),
              }),
              Effect.timeoutOption(200),
            );
            yield* Effect.yieldNow;
            if (Option.isSome(pending) && pending.value) return true;
          }
          if (page.done) return false;
          yield* Effect.yieldNow;
        } while (true);
      }),
    directory => Effect.promise(() => directory.close()).pipe(Effect.ignoreCause),
  ).pipe(Effect.orElseSucceed(() => false));
  const pending = yield* probe;
  return pending ? yield* worker.value.wake(threadnoteHome).pipe(Effect.orElseSucceed(() => false)) : false;
});
