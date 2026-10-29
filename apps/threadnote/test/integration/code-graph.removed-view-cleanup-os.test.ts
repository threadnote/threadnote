import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Clock, Deferred, Effect, Fiber, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS, CodeGraphStore} from '@threadnote/graph/store';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));
const REMOVED_AT = new Date(0).toISOString();
const OS_ROWS = 64;
const CHILD_MARKER_TIMEOUT_MILLISECONDS = 45_000;

type CleanupChildProcess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

interface CleanupChildMarker {
  readonly event: 'claim-committed';
  readonly processId: number;
  readonly revisions: readonly number[];
  readonly worktreeIds: readonly string[];
}

interface CleanupSqliteBlocker {
  readonly release: () => void;
}

interface CleanupSqliteStatement {
  readonly finalize: () => void;
}

describe('removed code graph view cleanup OS crash coordination', () => {
  effectIt.effect(
    'defers retryable contention, keeps a killed claim leased, and reclaims it at exact TTL',
    () =>
      TestClock.withLive(
        withFixture('threadnote-removed-cleanup-os-', ({contentionMarkerPath, databasePath, markerPath}) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
            yield* Effect.sync(() => seedDueRows(databasePath, OS_ROWS));
            const now = Date.parse('2026-03-01T00:00:00.000Z');

            yield* Effect.acquireUseRelease(
              Effect.sync(() => holdSqliteWriter(databasePath)),
              blocker =>
                Effect.acquireUseRelease(
                  startCleanupChild(databasePath, now, markerPath, contentionMarkerPath),
                  child =>
                    Effect.gen(function* () {
                      yield* waitForMarker(fs, contentionMarkerPath, child);
                      expect(yield* fs.readFileString(contentionMarkerPath)).toBe('retryable-sqlite-busy\n');
                      yield* Effect.sync(blocker.release);
                      yield* waitForMarker(fs, markerPath, child);
                      const marker = yield* readMarker(fs, markerPath);
                      const expectedKilled = Array.from({length: 32}, (_, index) => worktreeId(index));
                      expect(child.exitCode).toBeNull();
                      expect(marker).toMatchObject({event: 'claim-committed', revisions: Array(32).fill(1)});
                      expect(marker.worktreeIds).toEqual(expectedKilled);
                      expect(readLeasedRows(databasePath, expectedKilled)).toEqual(
                        EffectArray.map(expectedKilled, worktreeId => ({
                          next_attempt_at: now + 30_000,
                          revision: 1,
                          worktree_id: worktreeId,
                        })),
                      );

                      child.kill('SIGKILL');
                      yield* Effect.promise(() => child.exited);
                      expect(readLeasedRows(databasePath, expectedKilled)).toEqual(
                        EffectArray.map(expectedKilled, worktreeId => ({
                          next_attempt_at: now + 30_000,
                          revision: 1,
                          worktree_id: worktreeId,
                        })),
                      );

                      const successor = yield* store.claimRemovedViewCleanupCandidates(databasePath, now, 32, {
                        waitTimeoutMilliseconds: 30_000,
                      });
                      const expectedSuccessor = Array.from({length: 32}, (_, index) => worktreeId(index + 32));
                      expect(EffectArray.map(successor, entry => entry.worktreeId)).toEqual(expectedSuccessor);
                      expect(new Set([...marker.worktreeIds, ...expectedSuccessor])).toHaveLength(OS_ROWS);
                      expect(yield* store.claimRemovedViewCleanupCandidates(databasePath, now, 32)).toEqual([]);
                      expect(
                        yield* store.claimRemovedViewCleanupCandidates(
                          databasePath,
                          now + CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS - 1,
                          32,
                        ),
                      ).toEqual([]);

                      const reclaimed = yield* store.claimRemovedViewCleanupCandidates(
                        databasePath,
                        now + CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS,
                        32,
                      );
                      expect(EffectArray.map(reclaimed, entry => entry.worktreeId)).toEqual(expectedKilled);
                      expect(EffectArray.map(reclaimed, entry => entry.revision)).toEqual(Array(32).fill(2));
                    }),
                  terminateCleanupChild,
                ),
              blocker => Effect.sync(blocker.release),
            );
          }),
        ),
      ).pipe(provideTestLayer(ApplicationLayer)),
    60_000,
  );

  effectIt.effect('interrupts before SQLite open without consuming a cleanup prefix', () =>
    TestClock.withLive(
      withFixture('threadnote-removed-cleanup-interrupt-', ({databasePath}) =>
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.initialize(databasePath);
          yield* Effect.sync(() => seedDueRows(databasePath, 32));
          const entered = yield* Deferred.make<void>();
          const neverOpen = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
          const fiber = yield* store
            .claimRemovedViewCleanupCandidates(databasePath, yield* Clock.currentTimeMillis, 32, {
              beforeDatabaseOpen: () => neverOpen,
              waitTimeoutMilliseconds: 30_000,
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(fiber);
          expect(readQueueProgress(databasePath)).toEqual({cursor: undefined, leased: 0, revisions: 0, rows: 32});

          const claimed = yield* store.claimRemovedViewCleanupCandidates(
            databasePath,
            yield* Clock.currentTimeMillis,
            32,
          );
          expect(claimed).toHaveLength(32);
          expect(EffectArray.map(claimed, entry => entry.revision)).toEqual(Array(32).fill(1));
        }),
      ),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function withFixture<A, E, R>(
  prefix: string,
  use: (fixture: {
    readonly contentionMarkerPath: string;
    readonly databasePath: string;
    readonly markerPath: string;
  }) => Effect.Effect<A, E, R>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix});
      return yield* use({
        contentionMarkerPath: path.join(root, 'retryable-contention.marker'),
        databasePath: path.join(root, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'graph-v3.sqlite'),
        markerPath: path.join(root, 'claim-committed.json'),
      });
    }),
  );
}

function seedDueRows(databasePath: string, count: number): void {
  const database = new Database(databasePath, {strict: true});
  const statements: CleanupSqliteStatement[] = [];
  try {
    const tombstone = database.prepare(
      'INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at) VALUES (?, ?, ?)',
    );
    statements.push(tombstone);
    const cleanup = database.prepare(
      `INSERT INTO removed_view_cleanup (
         worktree_id, expected_snapshot_id, removed_at, epoch, repository_id,
         provenance_record_digest, provenance_record_identity, phase, cursor_token,
         revision, attempts, next_attempt_at, blocked_code, updated_at
       ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'vector-pointers', NULL, 0, 0, 0, NULL, ?)`,
    );
    statements.push(cleanup);
    const sequence = database.query(
      "UPDATE schema_metadata SET value = ? WHERE key = 'removed_view_cleanup_epoch_sequence'",
    );
    statements.push(sequence);
    database.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const worktree = worktreeId(index);
        const snapshot = snapshotId(index);
        tombstone.run(worktree, snapshot, REMOVED_AT);
        cleanup.run(worktree, snapshot, REMOVED_AT, index + 1, REMOVED_AT);
      }
      sequence.run(String(count));
    })();
  } finally {
    // This seed hands the database to another OS process immediately. A weak
    // close keeps prepared statements and their connection alive until GC.
    finalizeStatementsAndClose(database, statements);
  }
}

function holdSqliteWriter(databasePath: string): CleanupSqliteBlocker {
  const database = new Database(databasePath, {create: false, strict: true});
  database.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
  let released = false;
  return {
    release: () => {
      if (released) return;
      try {
        if (database.inTransaction) database.exec('ROLLBACK');
      } finally {
        database.close(true);
        released = true;
      }
    },
  };
}

function startCleanupChild(databasePath: string, now: number, markerPath: string, contentionMarkerPath: string) {
  return Effect.sync(() =>
    Bun.spawn({
      cmd: [
        process.execPath,
        'run',
        `${process.cwd()}/apps/threadnote/test/helpers/code-graph-removed-view-cleanup-child.ts`,
        databasePath,
        String(now),
        markerPath,
        contentionMarkerPath,
      ],
      stderr: 'pipe',
      stdout: 'pipe',
    }),
  );
}

function terminateCleanupChild(child: CleanupChildProcess): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (child.exitCode === null) child.kill('SIGKILL');
    yield* Effect.promise(() => child.exited);
  });
}

function waitForMarker(fs: FileSystem.FileSystem, markerPath: string, child: CleanupChildProcess) {
  return Effect.gen(function* () {
    // The child deliberately allows 30 seconds to acquire the writer gate.
    // Keep the process-start barrier above that contract so a slow CI runner
    // cannot turn valid lock backpressure into a premature marker timeout.
    const deadline = (yield* Clock.currentTimeMillis) + CHILD_MARKER_TIMEOUT_MILLISECONDS;
    while (!(yield* fs.exists(markerPath))) {
      if (child.exitCode !== null) {
        yield* Effect.promise(() => child.exited);
        const streams = yield* collectChildStreams(child);
        return yield* TestError.make({
          message: `Cleanup child exited before its commit marker: ${JSON.stringify(streams)}`,
        });
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        child.kill('SIGKILL');
        yield* Effect.promise(() => child.exited);
        const streams = yield* collectChildStreams(child);
        return yield* TestError.make({message: `Cleanup child missed its commit marker: ${JSON.stringify(streams)}`});
      }
      yield* Effect.sleep(10);
    }
  });
}

function collectChildStreams(child: CleanupChildProcess) {
  return Effect.all(
    {
      stderr: readBoundedChildStream(child.stderr, 4_096).pipe(
        Effect.map(output => Effect2.pipe(output, EffectString.trim)),
      ),
      stdout: readBoundedChildStream(child.stdout, 4_096).pipe(
        Effect.map(output => Effect2.pipe(output, EffectString.trim)),
      ),
    },
    {concurrency: 2},
  );
}

function readBoundedChildStream(stream: ReadableStream<Uint8Array>, maximumBytes: number) {
  return Effect.acquireUseRelease(
    Effect.sync(() => stream.getReader()),
    reader =>
      Effect.tryPromise({
        try: async () => {
          const decoder = new TextDecoder();
          let bytes = 0;
          let output = '';
          while (true) {
            const next = await reader.read();
            if (next.done) return output + decoder.decode();
            bytes += next.value.byteLength;
            if (bytes > maximumBytes) throw TestError.make({message: 'Cleanup child output exceeded its byte bound.'});
            output += decoder.decode(next.value, {stream: true});
          }
        },
        catch: cause => TestError.make({message: 'Could not read bounded cleanup child output.', cause}),
      }),
    reader => Effect.sync(() => reader.releaseLock()),
  );
}

function readMarker(fs: FileSystem.FileSystem, markerPath: string) {
  return fs.readFileString(markerPath).pipe(
    Effect.flatMap(content =>
      Effect.try({
        try: () => JSON.parse(content) as unknown,
        catch: cause => TestError.make({message: 'Cleanup child marker was invalid.', cause}),
      }),
    ),
    Effect.filterOrFail(isCleanupChildMarker, () =>
      TestError.make({message: 'Cleanup child marker shape was invalid.'}),
    ),
  );
}

function isCleanupChildMarker(value: unknown): value is CleanupChildMarker {
  if (typeof value !== 'object' || value === null || EffectArray.isArray(value)) return false;
  return (
    'event' in value &&
    value.event === 'claim-committed' &&
    'processId' in value &&
    Number.isSafeInteger(value.processId) &&
    'worktreeIds' in value &&
    EffectArray.isArray(value.worktreeIds) &&
    value.worktreeIds.length === 32 &&
    EffectArray.every(value.worktreeIds, id => typeof id === 'string' && /^[0-9a-f]{64}$/u.test(id)) &&
    'revisions' in value &&
    EffectArray.isArray(value.revisions) &&
    value.revisions.length === 32 &&
    EffectArray.every(value.revisions, revision => typeof revision === 'number' && Number.isSafeInteger(revision))
  );
}

function readLeasedRows(databasePath: string, worktreeIds: readonly string[]) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  const statements: CleanupSqliteStatement[] = [];
  try {
    const select = database.prepare<
      {readonly next_attempt_at: number; readonly revision: number; readonly worktree_id: string},
      [string]
    >(
      `SELECT worktree_id, revision, next_attempt_at
       FROM removed_view_cleanup WHERE worktree_id = ?`,
    );
    statements.push(select);
    return EffectArray.map(worktreeIds, worktreeId => select.get(worktreeId)!);
  } finally {
    finalizeStatementsAndClose(database, statements);
  }
}

function readQueueProgress(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  const statements: CleanupSqliteStatement[] = [];
  try {
    const aggregateStatement = database.query<
      {readonly leased: number; readonly revisions: number; readonly rows: number},
      []
    >(
      `SELECT COUNT(*) AS rows,
              SUM(CASE WHEN next_attempt_at > 0 THEN 1 ELSE 0 END) AS leased,
              SUM(revision) AS revisions
       FROM removed_view_cleanup`,
    );
    statements.push(aggregateStatement);
    const aggregate = aggregateStatement.get()!;
    const cursorStatement = database.query<{readonly value: string}, []>(
      "SELECT value FROM schema_metadata WHERE key = 'removed_view_cleanup_admission_cursor'",
    );
    statements.push(cursorStatement);
    const cursor = cursorStatement.get()?.value;
    return {...aggregate, cursor};
  } finally {
    finalizeStatementsAndClose(database, statements);
  }
}

function finalizeStatementsAndClose(database: Database, statements: readonly CleanupSqliteStatement[]): void {
  let firstFailure: unknown;
  let failed = false;
  for (const statement of statements) {
    try {
      statement.finalize();
    } catch (cause) {
      if (!failed) firstFailure = cause;
      failed = true;
    }
  }
  try {
    database.close(true);
  } catch (cause) {
    if (!failed) firstFailure = cause;
    failed = true;
  }
  if (failed) throw firstFailure;
}

function worktreeId(index: number): string {
  return Effect2.pipe(index.toString(16), EffectString.padStart(64, '0'));
}

function snapshotId(index: number): string {
  return `cgsn_${Effect2.pipe(index.toString(16), EffectString.padStart(40, '0'))}`;
}
