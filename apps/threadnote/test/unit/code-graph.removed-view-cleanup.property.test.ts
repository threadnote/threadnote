import {Array as EffectArray, Option as EffectOption} from 'effect';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {mkdtempSync, rmSync} from '@threadnote/testing/node-fs';
import {tmpdir} from '@threadnote/testing/node-os';
import {join} from '@threadnote/testing/node-path';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Clock, Effect} from 'effect';
import {TestClock} from 'effect/testing';
import fc from 'fast-check';
import {describe, expect} from 'vitest';
import {
  CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES,
  CodeGraphStore,
  type CodeGraphRemovedViewCleanupBlockedCode,
  type CodeGraphRemovedViewCleanupEntry,
  type CodeGraphRemovedViewCleanupPhase,
  type CodeGraphRemovedViewCleanupUpdate,
} from '@threadnote/graph/store';
import {CODE_GRAPH_EXTRACTOR_GENERATION} from '@threadnote/graph/types';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));
const REPOSITORY_ID = Effect2.pipe('b', EffectString.repeat(64));
const WORKTREE_ID = Effect2.pipe('c', EffectString.repeat(64));
const OTHER_WORKTREE_ID = Effect2.pipe('d', EffectString.repeat(64));
const RECORD_DIGEST = Effect2.pipe('e', EffectString.repeat(64));
const RECORD_IDENTITY = Effect2.pipe('f', EffectString.repeat(64));
const SNAPSHOT_A = `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`;
const SNAPSHOT_B = `cgsn_${Effect2.pipe('2', EffectString.repeat(40))}`;
const SNAPSHOT_C = `cgsn_${Effect2.pipe('3', EffectString.repeat(40))}`;

type StateMachineCommand =
  'advance' | 'bad-attempt' | 'clear-cursor' | 'defer' | 'no-op' | 'progress' | 'replay' | 'skip';

const commandArbitrary = fc.constantFrom<StateMachineCommand>(
  'progress',
  'defer',
  'advance',
  'replay',
  'no-op',
  'skip',
  'bad-attempt',
  'clear-cursor',
);

describe('removed code graph view cleanup state-machine properties', () => {
  fcEffectProp(
    effectIt,
    'accepts only modeled full-entry CAS transitions and keeps epoch evidence immutable',
    {commands: fc.array(commandArbitrary, {maxLength: 24})},
    ({commands}) =>
      TestClock.withLive(
        withFixture('threadnote-removed-cleanup-property-', databasePath =>
          Effect.gen(function* () {
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
            yield* Effect.sync(() => seedStateMachine(databasePath));
            yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_A, {
              cleanupEvidence: {
                recordDigest: RECORD_DIGEST,
                recordIdentity: RECORD_IDENTITY,
                repositoryId: REPOSITORY_ID,
              },
              requireReconciliationSchema: true,
            });

            const [claimed] = yield* store.claimRemovedViewCleanupCandidates(
              databasePath,
              yield* Clock.currentTimeMillis,
              1,
            );
            expect(claimed).toBeDefined();
            let current = claimed;
            let stale: CodeGraphRemovedViewCleanupEntry | undefined;
            const immutable = immutableIdentity(current);

            for (const [step, command] of commands.entries()) {
              if (command === 'replay') {
                if (stale !== undefined) {
                  const replay = progressUpdate(stale, step);
                  expect(yield* store.updateRemovedViewCleanup(databasePath, stale, replay)).toEqual({state: 'stale'});
                }
              } else {
                const transition = modeledTransition(current, command, step);
                if (transition.valid) {
                  const before = current;
                  const result = yield* store.updateRemovedViewCleanup(databasePath, current, transition.update);
                  expect(result.state).toBe('updated');
                  if (result.state !== 'updated')
                    throw TestError.make({message: 'modeled cleanup update was not applied'});
                  const expected = applyUpdate(current, transition.update);
                  expect(result.entry).toEqual(expected);
                  stale = before;
                  current = result.entry;
                } else {
                  const before = readCleanupEntry(databasePath, WORKTREE_ID, SNAPSHOT_A);
                  const failure = yield* store
                    .updateRemovedViewCleanup(databasePath, current, transition.update)
                    .pipe(Effect.flip);
                  expect(failure.message).toContain('update is invalid');
                  expect(readCleanupEntry(databasePath, WORKTREE_ID, SNAPSHOT_A)).toEqual(before);
                }
              }

              expect(readCleanupEntry(databasePath, WORKTREE_ID, SNAPSHOT_A)).toEqual(current);
              expect(immutableIdentity(current)).toEqual(immutable);
            }
          }),
        ),
      ).pipe(provideTestLayer(ApplicationLayer)),
    {fastCheck: {numRuns: 40}},
  );

  effectIt.effect('fences same-millisecond legacy rewrites with monotone epochs and bounded trigger revocation', () =>
    TestClock.withLive(
      withFixture('threadnote-removed-cleanup-aba-', databasePath =>
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.initialize(databasePath);
          yield* Effect.sync(() => seedAbaState(databasePath));

          yield* store.removeView(databasePath, OTHER_WORKTREE_ID, SNAPSHOT_C, {
            cleanupEvidence: {
              recordDigest: RECORD_DIGEST,
              recordIdentity: RECORD_IDENTITY,
              repositoryId: REPOSITORY_ID,
            },
            requireReconciliationSchema: true,
          });
          yield* Effect.sync(() => completeFixtureEpoch(databasePath, OTHER_WORKTREE_ID, SNAPSHOT_C));
          const unrelatedQueue = readCleanupEntry(databasePath, OTHER_WORKTREE_ID, SNAPSHOT_C);
          const unrelatedLeases = readSnapshotLeases(databasePath, SNAPSHOT_C);

          yield* store.removeView(databasePath, WORKTREE_ID, SNAPSHOT_A, {
            cleanupEvidence: {
              recordDigest: RECORD_DIGEST,
              recordIdentity: RECORD_IDENTITY,
              repositoryId: REPOSITORY_ID,
            },
            requireReconciliationSchema: true,
          });
          const claimedA = findClaim(
            yield* store.claimRemovedViewCleanupCandidates(databasePath, yield* Clock.currentTimeMillis, 32),
            SNAPSHOT_A,
          );
          const removedAt = claimedA.removedAt;

          yield* Effect.sync(() => legacyRewriteTombstone(databasePath, SNAPSHOT_B, removedAt));
          expect(yield* store.authorizeRemovedViewCleanup(databasePath, claimedA)).toEqual({state: 'stale'});
          const claimedB = findClaim(
            yield* store.claimRemovedViewCleanupCandidates(databasePath, (yield* Clock.currentTimeMillis) + 1, 32),
            SNAPSHOT_B,
          );
          expect(claimedB.epoch).toBeGreaterThan(claimedA.epoch);
          expect(
            EffectArray.filter(readSnapshotLeases(databasePath, SNAPSHOT_B), row => row.retire_when_inactive === 1),
          ).toHaveLength(1);

          yield* Effect.sync(() => legacyReplaceTombstone(databasePath, SNAPSHOT_B, removedAt));
          expect(yield* store.authorizeRemovedViewCleanup(databasePath, claimedB)).toEqual({state: 'stale'});
          const replacementB = findClaim(
            yield* store.claimRemovedViewCleanupCandidates(databasePath, (yield* Clock.currentTimeMillis) + 2, 32),
            SNAPSHOT_B,
          );
          expect(replacementB.epoch).toBeGreaterThan(claimedB.epoch);

          const completedB = yield* advanceToComplete(store, databasePath, replacementB);
          expect(completedB.phase).toBe('complete');
          yield* Effect.sync(() => legacyRewriteTombstone(databasePath, SNAPSHOT_A, removedAt));
          const replacementA = findClaim(
            yield* store.claimRemovedViewCleanupCandidates(databasePath, (yield* Clock.currentTimeMillis) + 3, 32),
            SNAPSHOT_A,
          );
          expect(replacementA.epoch).toBeGreaterThan(replacementB.epoch);
          expect(readCleanupEntry(databasePath, WORKTREE_ID, SNAPSHOT_B)).toEqual(completedB);

          yield* Effect.sync(() => legacyDeleteTombstone(databasePath));
          expect(readCleanupEntry(databasePath, WORKTREE_ID, SNAPSHOT_A)).toBeUndefined();
          expect(readCleanupEntry(databasePath, WORKTREE_ID, SNAPSHOT_B)).toEqual(completedB);
          expect(readCleanupEntry(databasePath, OTHER_WORKTREE_ID, SNAPSHOT_C)).toEqual(unrelatedQueue);
          expect(readSnapshotLeases(databasePath, SNAPSHOT_C)).toEqual(unrelatedLeases);
        }),
      ),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function withFixture<A, E, R>(prefix: string, use: (databasePath: string) => Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), prefix))),
        path => Effect.sync(() => rmSync(path, {force: true, recursive: true})),
      );
      return yield* use(join(root, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'graph-v3.sqlite'));
    }),
  );
}

function modeledTransition(
  entry: CodeGraphRemovedViewCleanupEntry,
  command: Exclude<StateMachineCommand, 'replay'>,
  step: number,
): {readonly update: CodeGraphRemovedViewCleanupUpdate; readonly valid: boolean} {
  const timestamp = nextTimestamp(entry);
  const phaseIndex = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.indexOf(entry.phase);
  const terminal = phaseIndex === CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.length - 1;
  if (command === 'progress' && !terminal) return {update: progressUpdate(entry, step), valid: true};
  if (command === 'defer' && !terminal) {
    return {
      update: {
        attempts: entry.attempts + 1,
        blockedCode: 'busy',
        cursorToken: entry.cursorToken,
        nextAttemptAt: entry.nextAttemptAt + 1,
        phase: entry.phase,
        updatedAt: timestamp,
      },
      valid: true,
    };
  }
  if (command === 'advance' && !terminal) {
    return {
      update: {
        attempts: 0,
        nextAttemptAt: entry.nextAttemptAt,
        phase: CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES[phaseIndex + 1],
        updatedAt: timestamp,
      },
      valid: true,
    };
  }
  if (command === 'bad-attempt' && !terminal) {
    return {
      update: {
        attempts: entry.attempts + 2,
        blockedCode: 'busy',
        cursorToken: entry.cursorToken,
        nextAttemptAt: entry.nextAttemptAt + 1,
        phase: entry.phase,
        updatedAt: timestamp,
      },
      valid: false,
    };
  }
  if (command === 'skip' && phaseIndex + 2 < CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.length) {
    return {
      update: {
        attempts: 0,
        nextAttemptAt: entry.nextAttemptAt,
        phase: CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES[phaseIndex + 2],
        updatedAt: timestamp,
      },
      valid: false,
    };
  }
  return {
    update: {
      attempts: entry.attempts,
      cursorToken: command === 'clear-cursor' ? undefined : entry.cursorToken,
      nextAttemptAt: entry.nextAttemptAt,
      phase: entry.phase,
      updatedAt: entry.updatedAt,
    },
    valid: false,
  };
}

function progressUpdate(entry: CodeGraphRemovedViewCleanupEntry, step: number): CodeGraphRemovedViewCleanupUpdate {
  return {
    attempts: entry.attempts,
    cursorToken: `progress-${step}-${entry.revision}`,
    nextAttemptAt: entry.nextAttemptAt,
    phase: entry.phase,
    updatedAt: nextTimestamp(entry),
  };
}

function applyUpdate(
  entry: CodeGraphRemovedViewCleanupEntry,
  update: CodeGraphRemovedViewCleanupUpdate,
): CodeGraphRemovedViewCleanupEntry {
  return {
    attempts: update.attempts,
    ...(update.blockedCode === undefined ? {} : {blockedCode: update.blockedCode}),
    ...(update.cursorToken === undefined ? {} : {cursorToken: update.cursorToken}),
    epoch: entry.epoch,
    expectedSnapshotId: entry.expectedSnapshotId,
    nextAttemptAt: update.nextAttemptAt,
    phase: update.phase,
    ...(entry.provenanceRecordDigest === undefined ? {} : {provenanceRecordDigest: entry.provenanceRecordDigest}),
    ...(entry.provenanceRecordIdentity === undefined ? {} : {provenanceRecordIdentity: entry.provenanceRecordIdentity}),
    removedAt: entry.removedAt,
    ...(entry.repositoryId === undefined ? {} : {repositoryId: entry.repositoryId}),
    revision: entry.revision + 1,
    updatedAt: update.updatedAt,
    worktreeId: entry.worktreeId,
  };
}

function immutableIdentity(entry: CodeGraphRemovedViewCleanupEntry) {
  return {
    epoch: entry.epoch,
    expectedSnapshotId: entry.expectedSnapshotId,
    provenanceRecordDigest: entry.provenanceRecordDigest,
    provenanceRecordIdentity: entry.provenanceRecordIdentity,
    removedAt: entry.removedAt,
    repositoryId: entry.repositoryId,
    worktreeId: entry.worktreeId,
  };
}

function nextTimestamp(entry: CodeGraphRemovedViewCleanupEntry): string {
  return new Date(Date.parse(entry.updatedAt) + 1).toISOString();
}

function seedStateMachine(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    seedRepository(database);
    seedSnapshot(database, SNAPSHOT_A, WORKTREE_ID);
    seedActivePointer(database, WORKTREE_ID, SNAPSHOT_A);
  } finally {
    database.close(false);
  }
}

function seedAbaState(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    seedRepository(database);
    seedSnapshot(database, SNAPSHOT_A, WORKTREE_ID);
    seedSnapshot(database, SNAPSHOT_B, WORKTREE_ID);
    seedSnapshot(database, SNAPSHOT_C, OTHER_WORKTREE_ID);
    seedActivePointer(database, WORKTREE_ID, SNAPSHOT_A);
    seedActivePointer(database, OTHER_WORKTREE_ID, SNAPSHOT_C);
    const expiresAt = Date.now() + 60_000;
    database
      .query(
        `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
         VALUES (?, ?, ?, 0), (?, ?, ?, 0), (?, ?, ?, 0)`,
      )
      .run(
        'lease-b-1',
        SNAPSHOT_B,
        expiresAt,
        'lease-b-2',
        SNAPSHOT_B,
        expiresAt + 1,
        'lease-c',
        SNAPSHOT_C,
        expiresAt,
      );
  } finally {
    database.close(false);
  }
}

function seedRepository(database: Database): void {
  database
    .query(
      `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
       VALUES (?, 'removed-cleanup-property', 'sha1', ?, ?)`,
    )
    .run(REPOSITORY_ID, new Date(0).toISOString(), new Date(0).toISOString());
}

function seedSnapshot(database: Database, snapshotId: string, worktreeId: string): void {
  database
    .query(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
         extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
         edge_count, started_at, completed_at, failure_summary
       ) VALUES (?, ?, ?, ?, ?, NULL, 'removed-cleanup-property', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
    )
    .run(
      snapshotId,
      REPOSITORY_ID,
      worktreeId,
      Effect2.pipe('1', EffectString.repeat(40)),
      `cgc_${Effect2.pipe(snapshotId, EffectString.slice(-40))}`,
      new Date(0).toISOString(),
      new Date(0).toISOString(),
    );
  database
    .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
    .run(snapshotId, CODE_GRAPH_EXTRACTOR_GENERATION);
}

function seedActivePointer(database: Database, worktreeId: string, snapshotId: string): void {
  database
    .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
    .run(worktreeId, snapshotId, new Date(0).toISOString());
}

function completeFixtureEpoch(databasePath: string, worktreeId: string, snapshotId: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `UPDATE removed_view_cleanup
         SET phase = 'complete', cursor_token = NULL, blocked_code = NULL, revision = revision + 1
         WHERE worktree_id = ? AND expected_snapshot_id = ?`,
      )
      .run(worktreeId, snapshotId);
  } finally {
    database.close(false);
  }
}

function legacyRewriteTombstone(databasePath: string, snapshotId: string, removedAt: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query('UPDATE removed_views SET expected_snapshot_id = ?, removed_at = ? WHERE worktree_id = ?')
      .run(snapshotId, removedAt, WORKTREE_ID);
  } finally {
    database.close(false);
  }
}

function legacyReplaceTombstone(databasePath: string, snapshotId: string, removedAt: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query('INSERT OR REPLACE INTO removed_views (worktree_id, expected_snapshot_id, removed_at) VALUES (?, ?, ?)')
      .run(WORKTREE_ID, snapshotId, removedAt);
  } finally {
    database.close(false);
  }
}

function legacyDeleteTombstone(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.query('DELETE FROM removed_views WHERE worktree_id = ?').run(WORKTREE_ID);
  } finally {
    database.close(false);
  }
}

function findClaim(
  entries: readonly CodeGraphRemovedViewCleanupEntry[],
  snapshotId: string,
): CodeGraphRemovedViewCleanupEntry {
  const entry = EffectOption.getOrUndefined(
    EffectArray.findFirst(entries, candidate => candidate.expectedSnapshotId === snapshotId),
  );
  expect(entry).toBeDefined();
  return entry!;
}

function advanceToComplete(
  store: typeof CodeGraphStore.Service,
  databasePath: string,
  initial: CodeGraphRemovedViewCleanupEntry,
) {
  return Effect.gen(function* () {
    let entry = initial;
    while (entry.phase !== 'complete') {
      const phaseIndex = CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES.indexOf(entry.phase);
      const update: CodeGraphRemovedViewCleanupUpdate = {
        attempts: 0,
        nextAttemptAt: entry.nextAttemptAt,
        phase: CODE_GRAPH_REMOVED_VIEW_CLEANUP_PHASES[phaseIndex + 1],
        updatedAt: nextTimestamp(entry),
      };
      const result = yield* store.updateRemovedViewCleanup(databasePath, entry, update);
      expect(result.state).toBe('updated');
      if (result.state !== 'updated') throw TestError.make({message: 'cleanup phase did not advance'});
      entry = result.entry;
    }
    return entry;
  });
}

interface CleanupRow {
  readonly attempts: number;
  readonly blocked_code: CodeGraphRemovedViewCleanupBlockedCode | null;
  readonly cursor_token: string | null;
  readonly epoch: number;
  readonly expected_snapshot_id: string;
  readonly next_attempt_at: number;
  readonly phase: CodeGraphRemovedViewCleanupPhase;
  readonly provenance_record_digest: string | null;
  readonly provenance_record_identity: string | null;
  readonly removed_at: string;
  readonly repository_id: string | null;
  readonly revision: number;
  readonly updated_at: string;
  readonly worktree_id: string;
}

function readCleanupEntry(
  databasePath: string,
  worktreeId: string,
  snapshotId: string,
): CodeGraphRemovedViewCleanupEntry | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const row = database
      .query<CleanupRow, [string, string]>(
        `SELECT worktree_id, expected_snapshot_id, removed_at, epoch, repository_id,
                provenance_record_digest, provenance_record_identity, phase, cursor_token,
                revision, attempts, next_attempt_at, blocked_code, updated_at
         FROM removed_view_cleanup
         WHERE worktree_id = ? AND expected_snapshot_id = ?`,
      )
      .get(worktreeId, snapshotId);
    if (row === null) return undefined;
    return {
      attempts: row.attempts,
      ...(row.blocked_code === null ? {} : {blockedCode: row.blocked_code}),
      ...(row.cursor_token === null ? {} : {cursorToken: row.cursor_token}),
      epoch: row.epoch,
      expectedSnapshotId: row.expected_snapshot_id,
      nextAttemptAt: row.next_attempt_at,
      phase: row.phase,
      ...(row.provenance_record_digest === null ? {} : {provenanceRecordDigest: row.provenance_record_digest}),
      ...(row.provenance_record_identity === null ? {} : {provenanceRecordIdentity: row.provenance_record_identity}),
      removedAt: row.removed_at,
      ...(row.repository_id === null ? {} : {repositoryId: row.repository_id}),
      revision: row.revision,
      updatedAt: row.updated_at,
      worktreeId: row.worktree_id,
    };
  } finally {
    database.close(false);
  }
}

function readSnapshotLeases(databasePath: string, snapshotId: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly expires_at: number; readonly retire_when_inactive: number; readonly token: string}, [string]>(
        `SELECT token, expires_at, retire_when_inactive
         FROM snapshot_leases WHERE snapshot_id = ? ORDER BY token`,
      )
      .all(snapshotId);
  } finally {
    database.close(false);
  }
}
