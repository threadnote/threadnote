import {it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Cause, Deferred, Duration, Effect, Exit, Fiber, FileSystem, Option, Path} from 'effect';
import {SecureRandom} from 'effect/crypto';
import * as SqlClient from 'effect/sql/SqlClient';
import type * as SqlConnection from 'effect/sql/SqlConnection';
import * as Statement from 'effect/sql/Statement';
import * as Reactivity from 'effect/reactivity/Reactivity';
import * as EffectString from 'effect/String';
import {TestClock} from 'effect/testing';
import {describe, expect, vi} from 'vitest';
import {SystemInfo, type SystemInfoShape} from '@threadnote/platform/system';
import {CommandExecutor} from '@threadnote/platform/command';
import type {ExclusiveFileLockOptions} from '@threadnote/platform/file/lock';
import {
  EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE,
  makeCodeGraphBuildResourceCoordinator,
} from '../../src/build/resources.js';
import {
  CODE_GRAPH_INTERRUPTED_BUILD_SUMMARY,
  ensureCommittedBase,
  settleInterruptedCodeGraphBuild,
} from '../../src/indexer/build.js';
import {writerSessionOptions} from '../../src/indexer/build_session.js';
import type {CodeGraphLayout} from '../../src/layout.js';
import {releasePersistentSnapshotBuild} from '../../src/store/persistent_build.js';
import {makeCodeGraphStoreRuntime} from '../../src/store/runtime.js';
import {CodeGraphDatabaseSession} from '../../src/store/session.js';
import {storeError} from '../../src/store/utilities.js';
import type {CodeGraphStoreShape} from '../../src/store/shape.js';
import type {CodeGraphSnapshot, RepositoryIdentity} from '../../src/types.js';

const boundary = vi.hoisted(() => ({events: [] as string[]}));

// This is a call-order boundary, not a proof of real filesystem locking or SQLite transactions.
vi.mock('@threadnote/platform/file/lock', async () => {
  const {Effect: effect} = await import('effect');
  return {
    isFileLockTimeout: () => false,
    withExclusiveFileLock: <A, E, R>(
      _fs: FileSystem.FileSystem,
      lockPath: string,
      options: ExclusiveFileLockOptions,
      program: Effect.Effect<A, E, R>,
    ) =>
      effect.acquireUseRelease(
        effect.sync(() => boundary.events.push('physical:acquired')),
        () =>
          effect.gen(function* () {
            yield* options.onAcquired?.(lockPath) ?? effect.void;
            return yield* program.pipe(effect.ensuring(options.onCompleted?.(lockPath) ?? effect.void));
          }),
        () => effect.sync(() => boundary.events.push('physical:released')),
      ),
  };
});

function unexpected(name: string): never {
  throw new Error(`Unexpected boundary: ${name}`);
}

function unusedService<A extends object>(name: string): A {
  return new Proxy<A>(Object.create(null), {
    get: (_target, property) => unexpected(`${name}.${String(property)}`),
  });
}

const databasePath = 'mandatory-cleanup.sqlite';
const snapshotId = 'controlled-resumable-snapshot';
const ownerToken = 'controlled-owner-token';
const leaseToken = 'controlled-snapshot-lease';
const layout: CodeGraphLayout = {
  checkoutId: 'controlled-checkout',
  databaseWriteLockPath: 'mandatory-cleanup.lock',
  databasePath,
  lockPath: 'unused-process.lock',
  repositoryRoot: 'unused-repository',
  staleMarkerPath: 'unused-stale-marker',
  vectorRoot: 'unused-vectors',
  worktreeLockRoot: 'unused-worktree-locks',
  worktreeId: 'controlled-worktree',
};

// Observe the real SQL program's calls and bindings, without implementing a second SQL/state engine.
const makeSqlBoundary = Effect.fn('test.mandatoryWriterCleanup.sqlBoundary')(function* () {
  const calls: Array<{readonly kind: string; readonly bindings: readonly unknown[]}> = [];
  const execute: SqlConnection.Connection['execute'] = (statement, bindings) =>
    Effect.sync(() => {
      if (EffectString.startsWith('PRAGMA ')(statement)) {
        expect([
          'PRAGMA foreign_keys = ON',
          'PRAGMA busy_timeout = 5000',
          'PRAGMA journal_size_limit = 67108864',
        ]).toContain(statement);
        calls.push({kind: statement, bindings: []});
        return [];
      }
      if (EffectString.includes('UPDATE snapshots')(statement)) {
        expect(statement).toContain("AND state = 'building'");
        expect(statement).toContain('owner.owner_token = ?');
        expect(statement).toContain('RETURNING id');
        calls.push({kind: 'update-summary', bindings});
        return [{id: snapshotId}];
      }
      if (EffectString.includes('DELETE FROM snapshot_build_owners')(statement)) {
        expect(statement).toContain('WHERE snapshot_id = ? AND owner_token = ?');
        calls.push({kind: 'delete-owner', bindings});
        return [];
      }
      return unexpected('SQL statement outside persistent release');
    });
  const connection: SqlConnection.Connection = {
    execute,
    executeRaw: () => unexpected('executeRaw'),
    executeStream: () => unexpected('executeStream'),
    executeValues: () => unexpected('executeValues'),
    executeValuesUnprepared: () => unexpected('executeValuesUnprepared'),
    executeUnprepared: () => unexpected('executeUnprepared'),
  };
  const reactivity = yield* Reactivity.make;
  const client = yield* SqlClient.make({
    acquirer: Effect.succeed(connection),
    compiler: Statement.makeCompilerSqlite(),
    driver: 'controlled-test-boundary',
    spanAttributes: [],
  }).pipe(Effect.provideService(Reactivity.Reactivity, reactivity));
  // Preserve the original counted pass-through boundary: no BEGIN/COMMIT or real transaction is claimed.
  const sql = Object.assign(client, {
    withTransaction: <A, E, R>(program: Effect.Effect<A, E, R>) =>
      Effect.sync(() => calls.push({kind: 'transaction', bindings: []})).pipe(Effect.andThen(program)),
  });
  return {sql, calls};
});

const fixture = Effect.fn('test.mandatoryWriterCleanup.fixture')(function* (sql: SqlClient.SqlClient) {
  boundary.events.length = 0;
  const factories = {resource: 0, progress: 0};
  let rejectObservation = true;
  const notification = (kind: keyof typeof factories) => {
    factories[kind]++;
    return rejectObservation ? Effect.die(`optional ${kind} factory ran during mandatory cleanup`) : Effect.void;
  };
  const resources = yield* makeCodeGraphBuildResourceCoordinator(() => notification('resource'));
  const callbacks = writerSessionOptions(layout, {}, () => notification('progress'), resources);
  const session = CodeGraphDatabaseSession.of({
    databasePath,
    sql,
    schemaInitialized: true,
    reconstructibleDurabilityConfigured: false,
    detachedCleanupRequest: {completedBuild: false, completedSnapshotId: undefined, routinePhysical: false},
    ...callbacks,
  });
  const path = new Proxy<Path.Path>(Object.create(null), {
    get: (_target, property) =>
      property === 'basename'
        ? (value: string) => (value === databasePath ? value : unexpected('basename input'))
        : unexpected(`path.${String(property)}`),
  });
  const filesystem = unusedService<FileSystem.FileSystem>('filesystem');
  const crypto = unusedService<SecureRandom.SecureRandom['Service']>('crypto');
  const system = unusedService<SystemInfoShape>('system');
  const command = CommandExecutor.of({
    execute: () => unexpected('command.execute'),
    executeBytes: () => unexpected('command.executeBytes'),
    executeStreaming: () => unexpected('command.executeStreaming'),
    spawnDetached: () => unexpected('command.spawnDetached'),
  });
  const provideEntry = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    program.pipe(
      Effect.provideService(CommandExecutor, command),
      Effect.provideService(FileSystem.FileSystem, filesystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SecureRandom.SecureRandom, crypto),
      Effect.provideService(SystemInfo, system),
    );
  const runtime = yield* makeCodeGraphStoreRuntime.pipe(provideEntry);
  const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    runtime
      .withWriterGate(databasePath, program)
      .pipe(Effect.provideService(CodeGraphDatabaseSession, session), Effect.provideService(SqlClient.SqlClient, sql));
  return {
    resources,
    factories,
    run,
    filesystem,
    provideEntry,
    allowOrdinaryObservation: () => {
      rejectObservation = false;
    },
  };
});

const awaitOwnedInterruptedClosure = Effect.fn('test.mandatoryWriterCleanup.awaitClosure')(function* (
  worker: Fiber.Fiber<unknown, unknown>,
  interrupter: number,
) {
  const observer = yield* Fiber.await(worker).pipe(
    Effect.timeoutOption(Duration.millis(1)),
    Effect.forkChild({startImmediately: true}),
  );
  yield* TestClock.adjust(Duration.millis(1));
  const result = yield* Fiber.join(observer);
  expect(Option.isSome(result), 'owned cleanup must close without optional observation').toBe(true);
  if (Option.isNone(result)) return;
  expect(Exit.isFailure(result.value)).toBe(true);
  if (Exit.isFailure(result.value)) {
    expect(Cause.hasInterruptsOnly(result.value.cause)).toBe(true);
    expect(
      EffectArray.some(
        result.value.cause.reasons,
        reason => Cause.isInterruptReason(reason) && reason.fiberId === interrupter,
      ),
    ).toBe(true);
  }
});

function closedStore(overrides: Partial<CodeGraphStoreShape>): CodeGraphStoreShape {
  return new Proxy(unusedService<CodeGraphStoreShape>('store'), {
    get: (_target, property, receiver) =>
      property in overrides ? Reflect.get(overrides, property, receiver) : unexpected(`store.${String(property)}`),
  });
}

describe('mandatory cleanup through actual graph build entry points', () => {
  effectIt.effect(
    'runs persistent release SQL after the actual interrupted settlement entry is reached',
    () =>
      Effect.gen(function* () {
        const sql = yield* makeSqlBoundary();
        const f = yield* fixture(sql.sql);
        const bodyEntered = yield* Deferred.make<void>();
        const bodyBarrier = yield* Deferred.make<void>();
        const calls: Array<readonly unknown[]> = [];
        const store = closedStore({
          releasePersistentBuild: (database, snapshot, summary, owner) => {
            calls.push([database, snapshot, summary, owner]);
            return f
              .run(releasePersistentSnapshotBuild(snapshot, summary, owner))
              .pipe(Effect.mapError(cause => storeError('release persistent code graph snapshot', cause)));
          },
        });
        const workerProgram = Deferred.succeed(bodyEntered, undefined).pipe(
          Effect.andThen(Deferred.await(bodyBarrier)),
          Effect.onInterrupt(() => settleInterruptedCodeGraphBuild(store, databasePath, snapshotId, ownerToken)),
        );
        yield* Effect.acquireUseRelease(
          workerProgram.pipe(Effect.forkChild({startImmediately: true})),
          worker =>
            Effect.gen(function* () {
              yield* Deferred.await(bodyEntered);
              const interrupter = yield* Effect.fiberId;
              const request = yield* Fiber.interruptAs(worker, interrupter).pipe(
                Effect.forkChild({startImmediately: true}),
              );
              yield* awaitOwnedInterruptedClosure(worker, interrupter);
              expect(calls).toEqual([[databasePath, snapshotId, CODE_GRAPH_INTERRUPTED_BUILD_SUMMARY, ownerToken]]);
              expect(EffectArray.map(sql.calls, call => call.kind)).toEqual([
                'PRAGMA foreign_keys = ON',
                'PRAGMA busy_timeout = 5000',
                'PRAGMA journal_size_limit = 67108864',
                'transaction',
                'update-summary',
                'delete-owner',
              ]);
              expect(sql.calls[4]?.bindings).toEqual([CODE_GRAPH_INTERRUPTED_BUILD_SUMMARY, snapshotId, ownerToken]);
              expect(sql.calls[5]?.bindings).toEqual([snapshotId, ownerToken]);
              expect(f.factories).toEqual({resource: 0, progress: 0});
              expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
              expect(boundary.events).toEqual(['physical:acquired', 'physical:released']);
              yield* Fiber.join(request);
            }),
          worker => Deferred.succeed(bodyBarrier, undefined).pipe(Effect.andThen(Fiber.interrupt(worker))),
        );
        f.allowOrdinaryObservation();
        yield* f.run(Effect.void);
        expect(f.factories).toEqual({resource: 2, progress: 1});
        expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      }),
    5_000,
  );

  effectIt.effect(
    'completes the actual committed-base lease finalizer when cancellation arrives after normal exit',
    () =>
      Effect.gen(function* () {
        const sql = yield* makeSqlBoundary();
        const f = yield* fixture(sql.sql);
        const releaseEntered = yield* Deferred.make<void>();
        const continueRelease = yield* Deferred.make<void>();
        const calls = {acquire: 0, releaseInvoked: 0, releaseBody: 0, normalReturn: 0};
        const identity: RepositoryIdentity = {
          caseMode: 'sensitive',
          checkoutId: layout.checkoutId,
          displayName: 'controlled',
          gitCommonDirectory: 'unused-git',
          headCommit: '0000000000000000000000000000000000000000',
          objectFormat: 'sha1',
          repoRoot: 'unused-root',
          repositoryId: 'controlled-repository',
          worktreeId: layout.worktreeId,
        };
        const snapshot: CodeGraphSnapshot = {
          id: snapshotId,
          commit: identity.headCommit,
          dirty: false,
          edgeCount: 0,
          extractorSet: 'controlled',
          fileCount: 0,
          repositoryId: identity.repositoryId,
          state: 'ready',
          symbolCount: 0,
          worktreeId: identity.worktreeId,
        };
        const store = closedStore({
          currentLexicalReadySnapshotById: () => Effect.succeed(snapshot),
          acquireSnapshotLease: (database, id, milliseconds) =>
            Effect.sync(() => {
              expect(database).toBe(databasePath);
              expect(id).toBe(snapshotId);
              expect(milliseconds).toBeGreaterThan(0);
              calls.acquire++;
              return leaseToken;
            }),
          releaseSnapshotLease: (database, token) => {
            calls.releaseInvoked++;
            expect(database).toBe(databasePath);
            expect(token).toBe(leaseToken);
            return Deferred.succeed(releaseEntered, undefined).pipe(
              Effect.andThen(Deferred.await(continueRelease)),
              Effect.andThen(
                f.run(
                  Effect.sync(() => {
                    calls.releaseBody++;
                  }),
                ),
              ),
              Effect.mapError(cause => storeError('release code graph snapshot lease', cause)),
            );
          },
        });
        type Input = Parameters<typeof ensureCommittedBase>[0];
        const languagePacks = new Proxy<Input['languagePacks']>(Object.create(null), {
          get: (_target, property) =>
            property === 'activeCacheIdentities' || property === 'activeDerivationIdentities'
              ? () => []
              : unexpected(`languagePacks.${String(property)}`),
        });
        const input: Input = {
          buildOwner: unusedService<Input['buildOwner']>('unused build owner'),
          capacityProtection: unusedService<Input['capacityProtection']>('unused capacity protection'),
          embedding: unusedService<Input['embedding']>('unused embedding'),
          force: false,
          fs: f.filesystem,
          identity,
          inventory: {committedFiles: [], committedParsedFiles: 0, dirty: false, files: [], parsedFiles: 0, skipped: 0},
          languagePacks,
          layout,
          startedAt: 0,
          store,
          threadnoteHome: 'unused-home',
        };
        const program = Effect.scoped(
          ensureCommittedBase(input).pipe(
            Effect.tap(result =>
              Effect.sync(() => {
                expect(Option.getOrUndefined(result.leaseToken)).toBe(leaseToken);
                calls.normalReturn++;
              }),
            ),
            f.provideEntry,
          ),
        );
        yield* Effect.acquireUseRelease(
          program.pipe(Effect.forkChild({startImmediately: true})),
          worker =>
            Effect.gen(function* () {
              yield* Deferred.await(releaseEntered);
              expect(calls).toEqual({acquire: 1, releaseInvoked: 1, releaseBody: 0, normalReturn: 1});
              expect(f.factories).toEqual({resource: 0, progress: 0});
              const interrupter = yield* Effect.fiberId;
              // The immediate child sends the public interrupt request, then awaits the masked finalizer.
              const request = yield* Fiber.interruptAs(worker, interrupter).pipe(
                Effect.forkChild({startImmediately: true}),
              );
              yield* Deferred.succeed(continueRelease, undefined);
              yield* awaitOwnedInterruptedClosure(worker, interrupter);
              expect(calls).toEqual({acquire: 1, releaseInvoked: 1, releaseBody: 1, normalReturn: 1});
              expect(f.factories).toEqual({resource: 0, progress: 0});
              expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
              expect(boundary.events).toEqual(['physical:acquired', 'physical:released']);
              expect(sql.calls).toEqual([]);
              yield* Fiber.join(request);
            }),
          worker => Deferred.succeed(continueRelease, undefined).pipe(Effect.andThen(Fiber.interrupt(worker))),
        );
        f.allowOrdinaryObservation();
        yield* f.run(Effect.void);
        expect(f.factories).toEqual({resource: 2, progress: 1});
        expect(yield* f.resources.current).toEqual(EMPTY_CODE_GRAPH_BUILD_RESOURCE_STATE);
      }),
    5_000,
  );
});
