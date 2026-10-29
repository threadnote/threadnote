import {Array as EffectArray} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {Database} from 'bun:sqlite';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Crypto, DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema} from 'effect';
import {TestClock} from 'effect/testing';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphVectorWriteLockPath} from '@threadnote/graph/layout';
import {
  captureCodeGraphLocalProvenanceCleanupEvidence,
  withCodeGraphLocalProvenanceLock,
  type CodeGraphLocalProvenanceCleanupEvidence,
  type CodeGraphLocalProvenanceRecordV2,
} from '@threadnote/graph/local_provenance';
import {removeCodeGraphView} from '@threadnote/graph/view_removal';
import {
  codeGraphViewRemovalTargetFailure,
  renderCodeGraphViewRemovalResult,
  serializeCodeGraphViewRemovalResult,
} from '@threadnote/threadnote/code_graph/view_removal_output';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CODE_GRAPH_EXTRACTOR_GENERATION, CodeGraphStoreBusyError} from '@threadnote/graph/types';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';

import {SystemInfo} from '@threadnote/platform/system';
import {withCodeGraphTargetWorktreeLock} from '@threadnote/graph/maintenance/gate';
import {
  anonymousTelemetryDiagnosticFromError,
  readAnonymousTelemetryDiagnostic,
  readAnonymousTelemetryReportedOutcome,
} from '@threadnote/threadnote/telemetry/diagnostic';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));
const WORKTREE_ID = Effect2.pipe('1', EffectString.repeat(64));
const SNAPSHOT_ID = `cgsn_${Effect2.pipe('c', EffectString.repeat(40))}-direct`;
const SCOPED_SNAPSHOT_ID = `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}-direct`;
const SCOPE_ID = `code-graph-scope:${Effect2.pipe('e', EffectString.repeat(64))}`;
const ViewRemovalCommandTestLayer = Layer.merge(CodeGraphStore.layer, TestCommandExecutorLayer).pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);

describe('code graph remove-view command core', () => {
  effectIt.layer(ViewRemovalCommandTestLayer)(layerIt => {
    layerIt.effect('previews without mutation, applies exactly, and emits deterministic path-free JSON', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* viewActionFixture;
          const target = {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID, worktreeId: WORKTREE_ID};

          const preview = yield* removeCodeGraphView(fixture.home, target);
          const stale = yield* removeCodeGraphView(fixture.home, {
            ...target,
            snapshotId: `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}`,
          });
          const notFound = yield* removeCodeGraphView(fixture.home, {
            ...target,
            worktreeId: Effect2.pipe('2', EffectString.repeat(64)),
          });
          expect(preview).toMatchObject({applied: false, cleanup: {provenance: null, vectors: null}, state: 'ready'});
          expect(activeView(fixture.databasePath)).toBe(SNAPSHOT_ID);
          expect(removedView(fixture.databasePath)).toBeUndefined();
          expect(stale).toMatchObject({
            applied: false,
            observedSnapshotId: SNAPSHOT_ID,
            observedState: 'active',
            state: 'stale-target',
          });
          expect(notFound).toMatchObject({applied: false, state: 'not-found'});
          for (const result of [stale, notFound]) {
            const failure = codeGraphViewRemovalTargetFailure(result);
            expect(failure?.message).toMatch(result.state === 'stale-target' ? /changed/ : /does not exist/);
            expect(anonymousTelemetryDiagnosticFromError(failure)).toEqual({
              errorType: 'CodeGraphViewRemovalError',
            });
            expect(readAnonymousTelemetryDiagnostic(failure)).toEqual({errorType: 'CodeGraphViewRemovalError'});
            expect(readAnonymousTelemetryReportedOutcome(failure)).toBe('unavailable');
          }

          const first = yield* removeCodeGraphView(fixture.home, target, {apply: true});
          const retry = yield* removeCodeGraphView(fixture.home, target, {apply: true});
          expect(first).toMatchObject({applied: true, state: 'removed', warnings: []});
          expect(retry).toMatchObject({applied: true, state: 'already-removed', warnings: []});
          expect(activeView(fixture.databasePath)).toBeUndefined();
          expect(removedView(fixture.databasePath)).toBe(SNAPSHOT_ID);

          const serialized = serializeCodeGraphViewRemovalResult(first);
          expect(serialized).toBe(serializeCodeGraphViewRemovalResult(first));
          expect(JSON.parse(serialized)).toEqual(first);
          expect(serialized).not.toContain(fixture.home);
          expect(serialized).not.toContain('databasePath');
          expect(renderCodeGraphViewRemovalResult(first)).toContain(
            'Derived cleanup: vector retirement queued; provenance',
          );
        }),
      ),
    );

    layerIt.effect('removes one scoped view while preserving its full-repository sibling', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* viewActionFixture;
          yield* Effect.sync(() => seedScopedView(fixture.databasePath));
          const target = {
            checkoutId: CHECKOUT_ID,
            scopeId: SCOPE_ID,
            snapshotId: SCOPED_SNAPSHOT_ID,
            worktreeId: WORKTREE_ID,
          };

          const preview = yield* removeCodeGraphView(fixture.home, target);
          expect(preview).toMatchObject({applied: false, scopeId: SCOPE_ID, state: 'ready'});

          const applied = yield* removeCodeGraphView(fixture.home, target, {apply: true});
          expect(applied).toMatchObject({applied: true, scopeId: SCOPE_ID, state: 'removed'});
          expect(activeView(fixture.databasePath)).toBe(SNAPSHOT_ID);
          expect(activeView(fixture.databasePath, SCOPE_ID)).toBeUndefined();
          expect(removedView(fixture.databasePath, SCOPE_ID)).toBe(SCOPED_SNAPSHOT_ID);
        }),
      ),
    );

    layerIt.effect(
      'keeps core removal independent of a busy vector writer and leaves cleanup to the durable worker',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* viewActionFixture;
            const crypto = yield* Crypto.Crypto;
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const system = yield* SystemInfo;
            const vectorDatabase = yield* seedVectorDatabase(fixture.home);
            const acquired = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const owner = yield* withExclusiveFileLock(
              fs,
              codeGraphVectorWriteLockPath(path, fixture.home, CHECKOUT_ID, sha256HexSync('model-command')),
              {
                onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
                retryIntervalMilliseconds: 5,
                staleAfterMilliseconds: 120_000,
                waitTimeoutMilliseconds: 5_000,
              },
              Deferred.await(release),
            ).pipe(Effect.forkChild);
            yield* Deferred.await(acquired);

            const target = {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID, worktreeId: WORKTREE_ID};
            let kickedAfterTargetUnlock = false;
            const first = yield* removeCodeGraphView(fixture.home, target, {
              afterRemoval: () =>
                withCodeGraphTargetWorktreeLock(
                  fixture.home,
                  CHECKOUT_ID,
                  WORKTREE_ID,
                  Effect.sync(() => void (kickedAfterTargetUnlock = true)),
                ).pipe(
                  Effect.provideService(Crypto.Crypto, crypto),
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(SystemInfo, system),
                ),
              apply: true,
            });
            expect(first.state).toBe('removed');
            expect(first.cleanup.vectors).toBeNull();
            expect(first.warnings).toEqual([]);
            expect(kickedAfterTargetUnlock).toBe(true);
            expect(readCleanupQueueState(fixture.databasePath)).toEqual({
              attempts: 0,
              blocked_code: null,
              cursor_token: null,
              phase: 'vector-pointers',
              revision: 0,
            });
            expect(readVectorPointer(vectorDatabase)).toBe(SNAPSHOT_ID);

            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(owner);
            const retry = yield* removeCodeGraphView(fixture.home, target, {apply: true});
            expect(retry.state).toBe('already-removed');
            expect(retry.cleanup.vectors).toBeNull();
            expect(retry.warnings).toEqual([]);
            expect(readVectorPointer(vectorDatabase)).toBe(SNAPSHOT_ID);
          }),
        ),
    );

    layerIt.effect('binds a short pre-core provenance token to the fresh epoch and deletes only an exact match', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* viewActionFixture;
          const provenance = yield* seedLocalProvenance(fixture.home, DateTime.formatIso(DateTime.makeUnsafe(0)));
          const crypto = yield* Crypto.Crypto;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const lockReacquired = yield* Deferred.make<void>();
          const target = {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID, worktreeId: WORKTREE_ID};
          const evidence = yield* captureCodeGraphLocalProvenanceCleanupEvidence(fixture.home, target);
          if (evidence === undefined) throw TestError.make({message: 'expected exact provenance evidence'});

          const result = yield* removeCodeGraphView(fixture.home, target, {
            afterProvenanceEvidenceCapture: () =>
              withCodeGraphLocalProvenanceLock(
                fixture.home,
                CHECKOUT_ID,
                WORKTREE_ID,
                0,
                Deferred.succeed(lockReacquired, undefined).pipe(Effect.asVoid),
              ).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(FileSystem.FileSystem, provenance.fs),
                Effect.provideService(Path.Path, path),
                Effect.provideService(SystemInfo, system),
              ),
            apply: true,
          });

          expect(result.cleanup.provenance).toEqual({state: 'removed'});
          expect(yield* Deferred.isDone(lockReacquired)).toBe(true);
          expect(yield* provenance.fs.exists(provenance.sidecar)).toBe(false);
          expect(readCleanupEvidence(fixture.databasePath)).toEqual(cleanupEvidenceRow(evidence));
        }),
      ),
    );

    layerIt.effect('preserves both a post-core replacement and a sidecar first published after capture', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const replacementFixture = yield* viewActionFixture;
          const original = yield* seedLocalProvenance(
            replacementFixture.home,
            DateTime.formatIso(DateTime.makeUnsafe(0)),
          );
          const replacement = localProvenanceRecord(
            original.missingWorktree,
            DateTime.formatIso(DateTime.makeUnsafe(1)),
          );
          const target = {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID, worktreeId: WORKTREE_ID};
          const originalEvidence = yield* captureCodeGraphLocalProvenanceCleanupEvidence(
            replacementFixture.home,
            target,
          );
          if (originalEvidence === undefined) throw TestError.make({message: 'expected exact provenance evidence'});
          const replaced = yield* removeCodeGraphView(replacementFixture.home, target, {
            apply: true,
            beforeProvenanceCleanup: () =>
              original.fs.writeFileString(original.sidecar, `${JSON.stringify(replacement)}\n`, {
                flag: 'w',
                mode: 0o600,
              }),
          });
          expect(replaced.cleanup.provenance).toEqual({observedState: 'stale', state: 'preserved'});
          expect(JSON.parse(yield* original.fs.readFileString(original.sidecar))).toEqual(replacement);
          expect(readCleanupEvidence(replacementFixture.databasePath)).toEqual(cleanupEvidenceRow(originalEvidence));

          const absentFixture = yield* viewActionFixture;
          const absent = yield* localProvenancePaths(absentFixture.home);
          const published = localProvenanceRecord(absent.missingWorktree, DateTime.formatIso(DateTime.makeUnsafe(2)));
          const absentResult = yield* removeCodeGraphView(absentFixture.home, target, {
            apply: true,
            beforeProvenanceCleanup: () =>
              absent.fs.writeFileString(absent.sidecar, `${JSON.stringify(published)}\n`, {
                flag: 'w',
                mode: 0o600,
              }),
          });
          expect(absentResult.cleanup.provenance).toEqual({observedState: 'invalid', state: 'preserved'});
          expect(JSON.parse(yield* absent.fs.readFileString(absent.sidecar))).toEqual(published);
          expect(readCleanupEvidence(absentFixture.databasePath).repository_id).toBeNull();
        }),
      ),
    );

    layerIt.effect(
      'binds the captured epoch evidence while preserving a replacement published before core removal',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* viewActionFixture;
            const original = yield* seedLocalProvenance(fixture.home, DateTime.formatIso(DateTime.makeUnsafe(0)));
            const target = {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID, worktreeId: WORKTREE_ID};
            const originalEvidence = yield* captureCodeGraphLocalProvenanceCleanupEvidence(fixture.home, target);
            if (originalEvidence === undefined) throw TestError.make({message: 'expected exact provenance evidence'});
            const replacement = localProvenanceRecord(
              original.missingWorktree,
              DateTime.formatIso(DateTime.makeUnsafe(1)),
            );

            const result = yield* removeCodeGraphView(fixture.home, target, {
              afterProvenanceEvidenceCapture: () =>
                original.fs.writeFileString(original.sidecar, `${JSON.stringify(replacement)}\n`, {
                  flag: 'w',
                  mode: 0o600,
                }),
              apply: true,
            });

            expect(result.state).toBe('removed');
            expect(result.cleanup.provenance).toEqual({observedState: 'stale', state: 'preserved'});
            expect(JSON.parse(yield* original.fs.readFileString(original.sidecar))).toEqual(replacement);
            expect(readCleanupEvidence(fixture.databasePath)).toEqual(cleanupEvidenceRow(originalEvidence));
          }),
        ),
    );

    layerIt.effect('never reuses retry provenance after a post-core interruption', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const unchangedFixture = yield* viewActionFixture;
          const unchanged = yield* seedLocalProvenance(
            unchangedFixture.home,
            DateTime.formatIso(DateTime.makeUnsafe(0)),
          );
          const target = {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID, worktreeId: WORKTREE_ID};
          const unchangedEvidence = yield* captureCodeGraphLocalProvenanceCleanupEvidence(
            unchangedFixture.home,
            target,
          );
          if (unchangedEvidence === undefined) throw TestError.make({message: 'expected exact provenance evidence'});
          const unchangedInterrupted = yield* removeCodeGraphView(unchangedFixture.home, target, {
            apply: true,
            beforeProvenanceCleanup: () => Effect.fail(TestError.make({message: 'simulated post-core interruption'})),
          }).pipe(Effect.exit);
          expect(unchangedInterrupted._tag).toBe('Failure');
          const unchangedRetry = yield* removeCodeGraphView(unchangedFixture.home, target, {apply: true});
          expect(unchangedRetry.state).toBe('already-removed');
          expect(unchangedRetry.cleanup.provenance).toEqual({observedState: 'stale', state: 'preserved'});
          expect(yield* unchanged.fs.exists(unchanged.sidecar)).toBe(true);
          expect(readCleanupEvidence(unchangedFixture.databasePath)).toEqual(cleanupEvidenceRow(unchangedEvidence));

          const fixture = yield* viewActionFixture;
          const original = yield* seedLocalProvenance(fixture.home, DateTime.formatIso(DateTime.makeUnsafe(0)));
          const originalEvidence = yield* captureCodeGraphLocalProvenanceCleanupEvidence(fixture.home, target);
          if (originalEvidence === undefined) throw TestError.make({message: 'expected exact provenance evidence'});
          const interrupted = yield* removeCodeGraphView(fixture.home, target, {
            apply: true,
            beforeProvenanceCleanup: () => Effect.fail(TestError.make({message: 'simulated post-core interruption'})),
          }).pipe(Effect.exit);
          expect(interrupted._tag).toBe('Failure');
          expect(removedView(fixture.databasePath)).toBe(SNAPSHOT_ID);

          const replacement = localProvenanceRecord(
            original.missingWorktree,
            DateTime.formatIso(DateTime.makeUnsafe(1)),
          );
          yield* original.fs.writeFileString(original.sidecar, `${JSON.stringify(replacement)}\n`, {
            flag: 'w',
            mode: 0o600,
          });
          const retry = yield* removeCodeGraphView(fixture.home, target, {apply: true});

          expect(retry.state).toBe('already-removed');
          expect(retry.cleanup.provenance).toEqual({observedState: 'stale', state: 'preserved'});
          expect(JSON.parse(yield* original.fs.readFileString(original.sidecar))).toEqual(replacement);
          expect(readCleanupEvidence(fixture.databasePath)).toEqual(cleanupEvidenceRow(originalEvidence));
        }),
      ),
    );

    layerIt.effect('keeps a legacy unbound epoch unbound on an already-removed retry', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* viewActionFixture;
          const store = yield* CodeGraphStore;
          const target = {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID, worktreeId: WORKTREE_ID};
          expect(yield* store.removeView(fixture.databasePath, WORKTREE_ID, SNAPSHOT_ID)).toMatchObject({
            state: 'removed',
          });
          const provenance = yield* seedLocalProvenance(fixture.home, DateTime.formatIso(DateTime.makeUnsafe(0)));

          const retry = yield* removeCodeGraphView(fixture.home, target, {apply: true});

          expect(retry.state).toBe('already-removed');
          expect(retry.cleanup.provenance).toEqual({observedState: 'stale', state: 'preserved'});
          expect(yield* provenance.fs.exists(provenance.sidecar)).toBe(true);
          expect(readCleanupEvidence(fixture.databasePath)).toEqual({
            provenance_record_digest: null,
            provenance_record_identity: null,
            repository_id: null,
          });
        }),
      ),
    );

    layerIt.effect('returns promptly under sixteen zero-wait applies and bounded retries converge', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* viewActionFixture;
          const target = {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID, worktreeId: WORKTREE_ID};
          const startedAt = yield* TestClock.withLive(Clock.currentTimeMillis);
          const outcomes = yield* Effect.all(
            Array.from({length: 16}, () =>
              removeCodeGraphView(fixture.home, target, {apply: true}).pipe(
                Effect.match({
                  onFailure: error => ({error, state: 'failed' as const}),
                  onSuccess: result => ({result, state: 'succeeded' as const}),
                }),
              ),
            ),
            {concurrency: 'unbounded'},
          );
          const elapsed = (yield* TestClock.withLive(Clock.currentTimeMillis)) - startedAt;
          const successes = EffectArray.map(
            EffectArray.filter(outcomes, outcome => outcome.state === 'succeeded'),
            outcome => outcome.result,
          );
          const failures = EffectArray.map(
            EffectArray.filter(outcomes, outcome => outcome.state === 'failed'),
            outcome => outcome.error,
          );

          expect(EffectArray.filter(successes, result => result.state === 'removed')).toHaveLength(1);
          expect(
            EffectArray.every(successes, result => result.state === 'removed' || result.state === 'already-removed'),
          ).toBe(true);
          expect(EffectArray.every(failures, error => Schema.is(CodeGraphStoreBusyError)(error))).toBe(true);
          expect(
            EffectArray.every(failures, error => !Effect2.pipe(String(error), EffectString.includes(fixture.home))),
          ).toBe(true);
          expect(elapsed).toBeLessThan(5_000);

          const retries = yield* Effect.forEach(
            Array.from({length: 16}),
            () => removeCodeGraphView(fixture.home, target, {apply: true}),
            {concurrency: 1},
          );
          expect(EffectArray.every(retries, result => result.state === 'already-removed')).toBe(true);
        }),
      ),
    );

    layerIt.effect('refuses a symlinked checkout ancestor without mutating the external database', () =>
      Effect.scoped(
        Effect.gen(function* () {
          if (process.platform === 'win32') return;
          const fixture = yield* viewActionFixture;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const checkoutRoot = path.dirname(fixture.databasePath);
          const externalCheckout = path.join(fixture.home, 'external-checkout');
          yield* fs.rename(checkoutRoot, externalCheckout);
          yield* fs.symlink(externalCheckout, checkoutRoot);
          const target = {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID, worktreeId: WORKTREE_ID};

          const preview = yield* removeCodeGraphView(fixture.home, target).pipe(
            Effect.match({onFailure: error => error, onSuccess: () => undefined}),
          );
          const apply = yield* removeCodeGraphView(fixture.home, target, {apply: true}).pipe(
            Effect.match({onFailure: error => error, onSuccess: () => undefined}),
          );

          expect(preview).toBeInstanceOf(Error);
          expect(apply).toBeInstanceOf(Error);
          expect(String(preview)).not.toContain(fixture.home);
          expect(String(apply)).not.toContain(fixture.home);
          expect(activeView(path.join(externalCheckout, path.basename(fixture.databasePath)))).toBe(SNAPSHOT_ID);
          expect(removedView(path.join(externalCheckout, path.basename(fixture.databasePath)))).toBeUndefined();
        }),
      ),
    );
  });
});

const viewActionFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* CodeGraphStore;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-view-action-'});
  const databasePath = path.join(home, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'graph-v3.sqlite');
  yield* store.initialize(databasePath);
  yield* Effect.sync(() => seedGraph(databasePath));
  yield* store.acquireSnapshotLease(databasePath, SNAPSHOT_ID, 60_000);
  return {databasePath, home};
});

function seedGraph(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, 'threadnote/view-command', 'sha1', ?, ?)`,
      )
      .run(Effect2.pipe('b', EffectString.repeat(64)), new Date(0).toISOString(), new Date(0).toISOString());
    database
      .query(
        `INSERT INTO snapshots (
           id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
           dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
           failure_summary
         ) VALUES (?, ?, ?, ?, 'content-command', NULL, 'view-command-test', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
      )
      .run(
        SNAPSHOT_ID,
        Effect2.pipe('b', EffectString.repeat(64)),
        WORKTREE_ID,
        Effect2.pipe('f', EffectString.repeat(40)),
        new Date(0).toISOString(),
        new Date(1).toISOString(),
      );
    database
      .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
      .run(SNAPSHOT_ID, CODE_GRAPH_EXTRACTOR_GENERATION);
    database
      .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
      .run(WORKTREE_ID, SNAPSHOT_ID, new Date(2).toISOString());
  } finally {
    database.close(false);
  }
}

function seedScopedView(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO snapshots (
           id, repository_id, worktree_id, scope_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
           dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
           failure_summary
         ) VALUES (?, ?, ?, ?, ?, 'content-command-scoped', NULL, 'view-command-test', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
      )
      .run(
        SCOPED_SNAPSHOT_ID,
        Effect2.pipe('b', EffectString.repeat(64)),
        WORKTREE_ID,
        SCOPE_ID,
        Effect2.pipe('f', EffectString.repeat(40)),
        new Date(0).toISOString(),
        new Date(1).toISOString(),
      );
    database
      .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
      .run(SCOPED_SNAPSHOT_ID, CODE_GRAPH_EXTRACTOR_GENERATION);
    database
      .query('INSERT INTO active_snapshots (worktree_id, scope_id, snapshot_id, activated_at) VALUES (?, ?, ?, ?)')
      .run(WORKTREE_ID, SCOPE_ID, SCOPED_SNAPSHOT_ID, new Date(3).toISOString());
  } finally {
    database.close(false);
  }
}

function seedVectorDatabase(home: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(home, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'vectors', 'model-command');
    yield* fs.makeDirectory(root, {recursive: true, mode: 0o700});
    const databasePath = path.join(root, 'vectors-v2.sqlite');
    yield* Effect.sync(() => {
      const database = new Database(databasePath, {create: true, strict: true});
      try {
        database.run('PRAGMA user_version = 2');
        database.run(`CREATE TABLE vector_generations (
          generation TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, model_id TEXT NOT NULL,
          model_sha256 TEXT NOT NULL, dimensions INTEGER NOT NULL, template_version INTEGER NOT NULL,
          count INTEGER NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL
        )`);
        database.run('CREATE TABLE vector_pointers (worktree_id TEXT PRIMARY KEY, generation TEXT NOT NULL)');
        database
          .query(`INSERT INTO vector_generations VALUES (?, ?, 'model-command', ?, 3, 1, 0, 'ready', ?)`)
          .run(
            'generation-command',
            SNAPSHOT_ID,
            Effect2.pipe('e', EffectString.repeat(64)),
            DateTime.formatIso(DateTime.makeUnsafe(0)),
          );
        database
          .query('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)')
          .run(WORKTREE_ID, 'generation-command');
      } finally {
        database.close(false);
      }
    });
    return databasePath;
  });
}

function activeView(databasePath: string, scopeId = 'full-repository'): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly snapshot_id: string}, [string, string]>(
        'SELECT snapshot_id FROM active_snapshots WHERE worktree_id = ? AND scope_id = ?',
      )
      .get(WORKTREE_ID, scopeId)?.snapshot_id;
  } finally {
    database.close(false);
  }
}

function removedView(databasePath: string, scopeId = 'full-repository'): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly expected_snapshot_id: string}, [string, string]>(
        'SELECT expected_snapshot_id FROM removed_views WHERE worktree_id = ? AND scope_id = ?',
      )
      .get(WORKTREE_ID, scopeId)?.expected_snapshot_id;
  } finally {
    database.close(false);
  }
}

function readVectorPointer(databasePath: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly snapshot_id: string}, [string]>(
        `SELECT generation.snapshot_id
         FROM vector_pointers AS pointer
         JOIN vector_generations AS generation ON generation.generation = pointer.generation
         WHERE pointer.worktree_id = ?`,
      )
      .get(WORKTREE_ID)?.snapshot_id;
  } finally {
    database.close(false);
  }
}

function localProvenancePaths(home: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const worktrees = path.join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      CHECKOUT_ID,
      'local-context',
      'worktrees',
    );
    yield* fs.makeDirectory(worktrees, {recursive: true, mode: 0o700});
    if (process.platform !== 'win32') {
      yield* fs.chmod(path.dirname(worktrees), 0o700);
      yield* fs.chmod(worktrees, 0o700);
    }
    return {
      fs,
      missingWorktree: path.join(home, 'missing-worktree'),
      sidecar: path.join(worktrees, `${WORKTREE_ID}.json`),
    };
  });
}

function seedLocalProvenance(home: string, observedAt: string) {
  return Effect.gen(function* () {
    const paths = yield* localProvenancePaths(home);
    yield* paths.fs.writeFileString(
      paths.sidecar,
      `${JSON.stringify(localProvenanceRecord(paths.missingWorktree, observedAt))}\n`,
      {mode: 0o600},
    );
    return paths;
  });
}

function localProvenanceRecord(canonicalWorktreePath: string, observedAt: string): CodeGraphLocalProvenanceRecordV2 {
  return {
    canonicalWorktreePath,
    checkoutId: CHECKOUT_ID,
    headCommit: Effect2.pipe('f', EffectString.repeat(40)),
    observedAt,
    registration: {kind: 'main'},
    repositoryId: Effect2.pipe('b', EffectString.repeat(64)),
    schemaVersion: 2,
    worktreeId: WORKTREE_ID,
  };
}

function readCleanupEvidence(databasePath: string): {
  readonly provenance_record_digest: string | null;
  readonly provenance_record_identity: string | null;
  readonly repository_id: string | null;
} {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<
        {
          readonly provenance_record_digest: string | null;
          readonly provenance_record_identity: string | null;
          readonly repository_id: string | null;
        },
        []
      >(
        `SELECT repository_id, provenance_record_digest, provenance_record_identity
         FROM removed_view_cleanup
         WHERE worktree_id = '${WORKTREE_ID}' AND expected_snapshot_id = '${SNAPSHOT_ID}'`,
      )
      .get()!;
  } finally {
    database.close(false);
  }
}

function readCleanupQueueState(databasePath: string): {
  readonly attempts: number;
  readonly blocked_code: string | null;
  readonly cursor_token: string | null;
  readonly phase: string;
  readonly revision: number;
} {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<
        {
          readonly attempts: number;
          readonly blocked_code: string | null;
          readonly cursor_token: string | null;
          readonly phase: string;
          readonly revision: number;
        },
        []
      >(
        `SELECT attempts, blocked_code, cursor_token, phase, revision
         FROM removed_view_cleanup
         WHERE worktree_id = '${WORKTREE_ID}' AND expected_snapshot_id = '${SNAPSHOT_ID}'`,
      )
      .get()!;
  } finally {
    database.close(false);
  }
}

function cleanupEvidenceRow(evidence: CodeGraphLocalProvenanceCleanupEvidence) {
  return {
    provenance_record_digest: evidence.recordDigest,
    provenance_record_identity: evidence.recordIdentity,
    repository_id: evidence.repositoryId,
  };
}
