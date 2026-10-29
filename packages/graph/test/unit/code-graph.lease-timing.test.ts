import {Array as EffectArray} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Cause, Clock, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {Database} from 'bun:sqlite';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {CodeGraphStore, type CodeGraphLeaseTimingObserver} from '@threadnote/graph/store';
import {CodeGraphStoreBusyError, type RepositoryIdentity} from '@threadnote/graph/types';
import {withCodeGraphLeaseTiming} from '../../src/store/lease_timing.js';
import {citationPlatformLayer} from '../helpers/citation-platform.js';
import {analysisSnapshot} from '../helpers/code-graph-analysis.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const layer = CodeGraphStore.layer.pipe(Layer.provideMerge(citationPlatformLayer));

describe('snapshot lease diagnostic boundaries', () => {
  effectIt('leaves the original effect untouched when disabled', () => {
    const original = Effect.succeed(42);
    expect(withCodeGraphLeaseTiming(undefined, 'schema', original)).toBe(original);
  });

  fcEffectProp(
    effectIt,
    'preserves outcomes and nested duration under throwing observers',
    {
      before: fc.integer({min: 0, max: 50}),
      body: fc.integer({min: 0, max: 50}),
      after: fc.integer({min: 0, max: 50}),
      fail: fc.boolean(),
      throwBoundary: fc.constantFrom('begin', 'end', 'neither'),
    },
    ({before, body, after, fail, throwBoundary}) =>
      Effect.gen(function* () {
        const events: string[] = [];
        const observer: CodeGraphLeaseTimingObserver = (stage, boundary) => {
          events.push(`${stage}:${boundary}`);
          if (boundary === throwBoundary) throw new Error('observer only');
        };
        const failure = TestError.make({message: 'original'});
        const start = yield* Clock.currentTimeMillis;
        const exit = yield* withCodeGraphLeaseTiming(
          observer,
          'writer-gate',
          TestClock.adjust(before).pipe(
            Effect.andThen(withCodeGraphLeaseTiming(observer, 'session', TestClock.adjust(body))),
            Effect.andThen(TestClock.adjust(after)),
            Effect.andThen(fail ? Effect.fail(failure) : Effect.succeed(42)),
          ),
        ).pipe(Effect.exit);
        expect((yield* Clock.currentTimeMillis) - start).toBe(before + body + after);
        expect(events).toEqual(['writer-gate:begin', 'session:begin', 'session:end', 'writer-gate:end']);
        if (fail) {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(
              EffectArray.some(exit.cause.reasons, reason => Cause.isFailReason(reason) && reason.error === failure),
            ).toBe(true);
        } else expect(exit).toEqual(Exit.succeed(42));
      }),
    {fastCheck: {numRuns: 32}},
  );

  effectIt.effect('retains defects and completes boundaries after interruption and owned finalizers', () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const observer: CodeGraphLeaseTimingObserver = (stage, boundary) => {
        events.push(`${stage}:${boundary}`);
      };
      const defect = new Error('original defect');
      const failed = yield* withCodeGraphLeaseTiming(observer, 'schema', Effect.die(defect)).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      if (Exit.isFailure(failed))
        expect(
          EffectArray.some(failed.cause.reasons, reason => Cause.isDieReason(reason) && reason.defect === defect),
        ).toBe(true);
      const entered = yield* Deferred.make<void>();
      const fiber = yield* withCodeGraphLeaseTiming(
        observer,
        'session',
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              events.push('owned-finalizer');
            }),
          ),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      expect(events).toEqual(['schema:begin', 'schema:end', 'session:begin', 'owned-finalizer', 'session:end']);
    }),
  );

  effectIt.effect('records real lease nesting, preserves tokens, and retains zero-wait writer contention', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-lease-timing-'});
        const databasePath = path.join(root, 'graph.sqlite');
        const store = yield* CodeGraphStore;
        const identity: RepositoryIdentity = {
          caseMode: 'sensitive',
          checkoutId: Effect2.pipe('c', EffectString.repeat(64)),
          displayName: 'timing',
          gitCommonDirectory: root,
          headCommit: Effect2.pipe('1', EffectString.repeat(40)),
          objectFormat: 'sha1',
          repoRoot: root,
          repositoryId: Effect2.pipe('r', EffectString.repeat(64)),
          worktreeId: Effect2.pipe('w', EffectString.repeat(64)),
        };
        const snapshot = {
          ...analysisSnapshot([], []),
          repositoryId: identity.repositoryId,
          worktreeId: identity.worktreeId,
          commit: identity.headCommit,
        };
        yield* store.initialize(databasePath);
        yield* store.markBuilding(databasePath, identity, snapshot);
        yield* Effect.sync(() => {
          const database = new Database(databasePath);
          try {
            database.query("UPDATE snapshots SET state = 'ready' WHERE id = ?").run(snapshot.id);
            database
              .query(
                "INSERT INTO snapshot_extractor_generations (snapshot_id, generation) SELECT ?, CAST(value AS INTEGER) FROM schema_metadata WHERE key = 'minimum_extractor_generation'",
              )
              .run(snapshot.id);
          } finally {
            database.close(false);
          }
        });
        const events: string[] = [];
        const observer: CodeGraphLeaseTimingObserver = (stage, boundary) => {
          events.push(`${stage}:${boundary}`);
        };
        const token = yield* store.acquireSnapshotLease(databasePath, snapshot.id, 60_000, {
          onTiming: observer,
          waitTimeoutMilliseconds: 0,
        });
        expect(events).toEqual([
          'token:begin',
          'token:end',
          'prepare:begin',
          'prepare:end',
          'writer-gate:begin',
          'session:begin',
          'session-body:begin',
          'schema:begin',
          'schema:end',
          'lease-sql:begin',
          'connection-configure:begin',
          'connection-configure:end',
          'transaction:begin',
          'transaction-body:begin',
          'transaction-body:end',
          'transaction:end',
          'lease-sql:end',
          'prune:begin',
          'prune:end',
          'session-body:end',
          'session:end',
          'writer-gate:end',
        ]);
        events.length = 0;
        yield* store.releaseSnapshotLease(databasePath, token, {onTiming: observer, waitTimeoutMilliseconds: 0});
        expect(events).toEqual([
          'exists:begin',
          'exists:end',
          'writer-gate:begin',
          'session:begin',
          'session-body:begin',
          'schema:begin',
          'schema:end',
          'lease-sql:begin',
          'connection-configure:begin',
          'connection-configure:end',
          'transaction:begin',
          'transaction-body:begin',
          'transaction-body:end',
          'transaction:end',
          'lease-sql:end',
          'session-body:end',
          'session:end',
          'writer-gate:end',
        ]);
        const entered = yield* Deferred.make<void>();
        const owner = yield* withExclusiveFileLock(
          fs,
          `${databasePath}.writer.lock`,
          {
            retryIntervalMilliseconds: 10,
            staleAfterMilliseconds: 60_000,
            waitTimeoutMilliseconds: 0,
          },
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        events.length = 0;
        const busy = yield* store
          .acquireSnapshotLease(databasePath, snapshot.id, 60_000, {onTiming: observer, waitTimeoutMilliseconds: 0})
          .pipe(Effect.flip);
        expect(busy).toBeInstanceOf(CodeGraphStoreBusyError);
        expect(events).toEqual([
          'token:begin',
          'token:end',
          'prepare:begin',
          'prepare:end',
          'writer-gate:begin',
          'writer-gate:end',
        ]);
        yield* Fiber.interrupt(owner);
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- This test is the entry point and owns the scoped store layer.
      }).pipe(Effect.provide(layer)),
    ),
  );
});
