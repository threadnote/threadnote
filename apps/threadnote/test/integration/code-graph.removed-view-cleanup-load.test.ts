import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {createHash} from '@threadnote/testing/node-crypto';
import {existsSync, statSync} from '@threadnote/testing/node-fs';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Clock, Effect, FileSystem, Path} from 'effect';
import * as SqlClient from 'effect/sql/SqlClient';
import {TestClock} from 'effect/testing';
import {describe, expect} from 'vitest';
import {
  CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION,
  CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS,
  CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS,
  CodeGraphStore,
  type CodeGraphPersistentSchemaMigrationPhase,
} from '@threadnote/graph/store';
import {CODE_GRAPH_EXTRACTOR_GENERATION, CodeGraphStoreError} from '@threadnote/graph/types';
import {inspectPersistentExtensionTables} from '@threadnote/graph/store/schema/inspection';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import {legacyCodeGraphAuthorityStatements} from '@threadnote/graph/test/helpers/code-graph-legacy-authority';

const CHECKOUT_ID = 'a'.repeat(64);
const REPOSITORY_ID = 'b'.repeat(64);
const ANCHOR_WORKTREE_ID = 'f'.repeat(64);
const ANCHOR_SNAPSHOT_ID = `cgsn_${'f'.repeat(40)}`;
const REMOVED_AT = new Date(0).toISOString();
const LOAD_ROWS = 10_000;
const MIGRATION_ROWS = 73_000;
const MIGRATION_MAIN_GROWTH_LIMIT_BYTES = 2 * 1_048_576;
const MIGRATION_TRANSIENT_GROWTH_LIMIT_BYTES = 20 * 1_048_576;

describe('removed code graph view cleanup load and migration', () => {
  effectIt.effect(
    'durably rotates 10,000 due rows without starvation before or after lease wrap',
    () =>
      TestClock.withLive(
        withFixture('threadnote-removed-cleanup-due-load-', databasePath =>
          Effect.gen(function* () {
            const startedAt = performance.now();
            const rssBefore = process.memoryUsage().rss;
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
            yield* Effect.sync(() => {
              downgradeToRevision7(databasePath);
              seedTombstones(databasePath, LOAD_ROWS);
            });
            yield* store.initialize(databasePath);
            yield* Effect.sync(() => seedDueQueue(databasePath, LOAD_ROWS));

            const now = Date.parse('2026-01-01T00:00:00.000Z');
            const expected = Array.from({length: LOAD_ROWS}, (_, index) => worktreeId(index));
            const oversizedPage = yield* store.claimRemovedViewCleanupCandidates(
              databasePath,
              now,
              Number.MAX_SAFE_INTEGER,
            );
            expect(oversizedPage).toHaveLength(CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS);
            const firstPass = [
              ...oversizedPage.map(entry => entry.worktreeId),
              ...(yield* drainDueClaims(store, databasePath, now)),
            ];
            expect(firstPass).toHaveLength(LOAD_ROWS);
            expect(new Set(firstPass)).toHaveLength(LOAD_ROWS);
            expect([...firstPass].sort()).toEqual(expected);
            expect(yield* store.claimRemovedViewCleanupCandidates(databasePath, now, 32)).toEqual([]);
            expect(
              yield* store.claimRemovedViewCleanupCandidates(
                databasePath,
                now + CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS - 1,
                32,
              ),
            ).toEqual([]);

            const wrapNow = now + CODE_GRAPH_REMOVED_VIEW_CLEANUP_CLAIM_LEASE_MILLISECONDS;
            const concurrent = yield* Effect.all(
              Array.from({length: 4}, () =>
                store.claimRemovedViewCleanupCandidates(databasePath, wrapNow, 32, {
                  waitTimeoutMilliseconds: 30_000,
                }),
              ),
              {concurrency: 'unbounded'},
            );
            const concurrentIds = concurrent.flatMap(entries => entries.map(entry => entry.worktreeId));
            expect(concurrentIds).toHaveLength(4 * CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS);
            expect(new Set(concurrentIds)).toHaveLength(concurrentIds.length);
            const secondPass = [...concurrentIds, ...(yield* drainDueClaims(store, databasePath, wrapNow))];
            expect(secondPass).toHaveLength(LOAD_ROWS);
            expect(new Set(secondPass)).toHaveLength(LOAD_ROWS);
            expect([...secondPass].sort()).toEqual(expected);

            yield* logLoadEvidence({
              elapsedMilliseconds: Math.round(performance.now() - startedAt),
              event: 'removed-view-cleanup-due-load',
              firstPassRows: firstPass.length,
              pageRows: CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS,
              rssAfterBytes: process.memoryUsage().rss,
              rssBeforeBytes: rssBefore,
              secondPassRows: secondPass.length,
            });
          }),
        ),
      ).pipe(provideTestLayer(ApplicationLayer)),
    120_000,
  );

  effectIt.effect(
    'admits 10,000 legacy tombstones one bounded epoch per committed claim',
    () =>
      TestClock.withLive(
        withFixture('threadnote-removed-cleanup-admission-load-', databasePath =>
          Effect.gen(function* () {
            const startedAt = performance.now();
            const rssBefore = process.memoryUsage().rss;
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
            yield* Effect.sync(() => {
              downgradeToRevision7(databasePath);
              seedTombstones(databasePath, LOAD_ROWS);
            });
            yield* store.initialize(databasePath);
            expect(readCleanupSurface(databasePath).queueCount).toBe(0);

            const now = Date.parse('2026-02-01T00:00:00.000Z');
            for (let index = 0; index < LOAD_ROWS; index += 1) {
              const claimed = yield* store.claimRemovedViewCleanupCandidates(databasePath, now, 32);
              if (
                claimed.length !== 1 ||
                claimed[0]?.worktreeId !== worktreeId(index) ||
                claimed[0].epoch !== index + 1
              ) {
                throw TestError.make({message: `Cleanup admission diverged at bounded row ${index}.`});
              }
            }
            const surface = readCleanupSurface(databasePath);
            expect(surface).toMatchObject({
              admissionCursor: worktreeId(LOAD_ROWS - 1),
              epochCount: LOAD_ROWS,
              epochMaximum: LOAD_ROWS,
              epochMinimum: 1,
              epochSequence: String(LOAD_ROWS),
              queueCount: LOAD_ROWS,
            });
            expect(surface.epochSum).toBe((LOAD_ROWS * (LOAD_ROWS + 1)) / 2);
            expect(yield* store.claimRemovedViewCleanupCandidates(databasePath, now, 32)).toEqual([]);
            expect(readCleanupSurface(databasePath)).toMatchObject({
              admissionCursor: worktreeId(CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS - 1),
              epochCount: LOAD_ROWS,
              epochSequence: String(LOAD_ROWS),
              queueCount: LOAD_ROWS,
            });
            yield* logLoadEvidence({
              elapsedMilliseconds: Math.round(performance.now() - startedAt),
              epochMaximum: surface.epochMaximum,
              event: 'removed-view-cleanup-admission-load',
              queueRows: surface.queueCount,
              rssAfterBytes: process.memoryUsage().rss,
              rssBeforeBytes: rssBefore,
            });
          }),
        ),
      ).pipe(provideTestLayer(ApplicationLayer)),
    600_000,
  );

  effectIt.effect(
    'publishes revision 8 over 73,000 tombstones without eager queue backfill or authority drift',
    () =>
      TestClock.withLive(
        withFixture('threadnote-removed-cleanup-migration-load-', databasePath =>
          Effect.gen(function* () {
            const store = yield* CodeGraphStore;
            yield* store.initialize(databasePath);
            yield* Effect.sync(() => {
              seedAnchorAuthority(databasePath);
              downgradeToRevision7(databasePath);
              seedTombstones(databasePath, MIGRATION_ROWS);
            });
            const before = authorityDigest(databasePath);
            yield* Effect.sync(() => checkpointDatabase(databasePath));
            const baselineMainBytes = observedFileSize(databasePath);
            const baselineWalBytes = observedFileSize(`${databasePath}-wal`);
            const migrationStartedAt = performance.now();
            const rssBefore = process.memoryUsage().rss;
            const phases: CodeGraphPersistentSchemaMigrationPhase[] = [];
            let committedEvidence:
              | {
                  readonly databaseBytes: number;
                  readonly elapsedMilliseconds: number;
                  readonly walBytes: number;
                }
              | undefined;
            yield* store.withSession(
              databasePath,
              store.initialize(databasePath).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    committedEvidence = {
                      databaseBytes: observedFileSize(databasePath),
                      elapsedMilliseconds: Math.round(performance.now() - migrationStartedAt),
                      walBytes: observedFileSize(`${databasePath}-wal`),
                    };
                  }),
                ),
              ),
              {onPersistentSchemaMigrationPhase: phase => Effect.sync(() => phases.push(phase))},
            );
            if (committedEvidence === undefined)
              throw TestError.make({message: 'Cleanup migration evidence was not retained.'});
            const mainGrowthBytes = Math.max(0, committedEvidence.databaseBytes - baselineMainBytes);
            const walGrowthBytes = Math.max(0, committedEvidence.walBytes - baselineWalBytes);
            const sharedGrowthBytes = Math.max(
              0,
              committedEvidence.databaseBytes + committedEvidence.walBytes - baselineMainBytes - baselineWalBytes,
            );
            // The current upgrade also adds scope authority to the 73,000
            // legacy tombstones. Keep that bounded without mistaking the
            // expected one-time rewrite for an eager cleanup-queue backfill.
            expect(mainGrowthBytes).toBeLessThan(MIGRATION_MAIN_GROWTH_LIMIT_BYTES);
            expect(walGrowthBytes).toBeLessThan(MIGRATION_TRANSIENT_GROWTH_LIMIT_BYTES);
            expect(sharedGrowthBytes).toBeLessThan(MIGRATION_TRANSIENT_GROWTH_LIMIT_BYTES);
            const after = authorityDigest(databasePath);
            expect(after).toEqual(before);
            expect(phases).toEqual([
              'added-removed-view-cleanup',
              'migrated-query-indexes',
              'added-graph-scope-authority',
              'recorded-revision',
            ]);

            const surface = readCleanupSurface(databasePath);
            expect(surface).toMatchObject({
              epochCount: 0,
              epochSequence: '0',
              queueCount: 0,
              revision: String(CODE_GRAPH_PERSISTENT_EXTENSION_SCHEMA_REVISION),
            });
            expect(readCleanupObjectNames(databasePath)).toEqual([
              'removed_view_cleanup',
              'removed_view_cleanup_due',
              'removed_views_cleanup_revoke_delete',
              'removed_views_cleanup_revoke_insert',
              'removed_views_cleanup_revoke_update',
            ]);

            const extensionInspections = yield* store.withSession(
              databasePath,
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                return yield* inspectPersistentExtensionTables(sql);
              }),
              {readOnly: true},
            );
            expect(extensionInspections.filter(inspection => !inspection.exists || !inspection.compatible)).toEqual([]);

            const reopenPhases: CodeGraphPersistentSchemaMigrationPhase[] = [];
            yield* store.withSession(databasePath, store.initialize(databasePath), {
              onPersistentSchemaMigrationPhase: phase => Effect.sync(() => reopenPhases.push(phase)),
            });
            expect(reopenPhases).toEqual([]);
            expect(authorityDigest(databasePath)).toEqual(before);
            expect(readCleanupSurface(databasePath).queueCount).toBe(0);

            yield* logLoadEvidence({
              absoluteDatabaseBytes: committedEvidence.databaseBytes,
              absoluteWalBytes: committedEvidence.walBytes,
              baselineDatabaseBytes: baselineMainBytes,
              baselineWalBytes,
              elapsedMilliseconds: committedEvidence.elapsedMilliseconds,
              event: 'removed-view-cleanup-migration-load',
              incrementalDatabaseBytes: mainGrowthBytes,
              incrementalSharedBytes: sharedGrowthBytes,
              incrementalWalBytes: walGrowthBytes,
              migrationPhases: phases,
              queueRows: 0,
              rssAfterBytes: process.memoryUsage().rss,
              rssBeforeBytes: rssBefore,
              tombstoneRows: MIGRATION_ROWS,
            });
          }),
        ),
      ).pipe(provideTestLayer(ApplicationLayer)),
    120_000,
  );

  effectIt.effect('repeats the same typed, path-free rollback for malformed admission authority', () =>
    TestClock.withLive(
      withFixture('threadnote-removed-cleanup-malformed-load-', databasePath =>
        Effect.gen(function* () {
          const store = yield* CodeGraphStore;
          yield* store.initialize(databasePath);
          yield* Effect.sync(() => seedMalformedTombstone(databasePath));
          const before = corruptAdmissionFingerprint(databasePath);

          for (let attempt = 0; attempt < 2; attempt += 1) {
            const failure = yield* store
              .claimRemovedViewCleanupCandidates(databasePath, yield* Clock.currentTimeMillis, 32)
              .pipe(Effect.flip);
            expect(failure).toBeInstanceOf(CodeGraphStoreError);
            expect(failure.message).toContain('admission row is invalid');
            expect(failure.message).not.toContain(databasePath);
            expect(corruptAdmissionFingerprint(databasePath)).toEqual(before);
          }
        }),
      ),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

function withFixture<A, E, R>(prefix: string, use: (databasePath: string) => Effect.Effect<A, E, R>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({prefix});
      return yield* use(path.join(root, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'graph-v3.sqlite'));
    }),
  );
}

function downgradeToRevision7(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.run('BEGIN IMMEDIATE');
    try {
      for (const statement of legacyCodeGraphAuthorityStatements) database.exec(statement);
      database.exec(`
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_delete;
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_insert;
        DROP TRIGGER IF EXISTS removed_views_cleanup_revoke_update;
        DROP TABLE IF EXISTS removed_view_cleanup;
        DELETE FROM schema_metadata
        WHERE key IN ('removed_view_cleanup_epoch_sequence', 'removed_view_cleanup_admission_cursor');
        UPDATE schema_metadata SET value = '7' WHERE key = 'persistent_extension_schema_revision';
      `);
      database.run('COMMIT');
    } catch (error) {
      if (database.inTransaction) database.run('ROLLBACK');
      throw error;
    }
  } finally {
    database.close(false);
  }
}

function seedTombstones(databasePath: string, count: number): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const insert = database.prepare(
      'INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at) VALUES (?, ?, ?)',
    );
    database.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        insert.run(worktreeId(index), snapshotId(index), REMOVED_AT);
      }
    })();
  } finally {
    database.close(false);
  }
}

function seedDueQueue(databasePath: string, count: number): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const insert = database.prepare(
      `INSERT INTO removed_view_cleanup (
         worktree_id, expected_snapshot_id, removed_at, epoch, repository_id,
         provenance_record_digest, provenance_record_identity, phase, cursor_token,
         revision, attempts, next_attempt_at, blocked_code, updated_at
       ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'vector-pointers', NULL, 0, 0, 0, NULL, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        insert.run(worktreeId(index), snapshotId(index), REMOVED_AT, index + 1, REMOVED_AT);
      }
      database
        .query("UPDATE schema_metadata SET value = ? WHERE key = 'removed_view_cleanup_epoch_sequence'")
        .run(String(count));
    })();
  } finally {
    database.close(false);
  }
}

function seedAnchorAuthority(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, 'removed-cleanup-load', 'sha1', ?, ?)`,
      )
      .run(REPOSITORY_ID, REMOVED_AT, REMOVED_AT);
    database
      .query(
        `INSERT INTO snapshots (
           id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id,
           extractor_set, dirty, overlay_fingerprint, state, file_count, symbol_count,
           edge_count, started_at, completed_at, failure_summary
         ) VALUES (?, ?, ?, ?, ?, NULL, 'removed-cleanup-load', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
      )
      .run(
        ANCHOR_SNAPSHOT_ID,
        REPOSITORY_ID,
        ANCHOR_WORKTREE_ID,
        '1'.repeat(40),
        `cgc_${'f'.repeat(40)}`,
        REMOVED_AT,
        REMOVED_AT,
      );
    database
      .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
      .run(ANCHOR_SNAPSHOT_ID, CODE_GRAPH_EXTRACTOR_GENERATION);
    database
      .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
      .run(ANCHOR_WORKTREE_ID, ANCHOR_SNAPSHOT_ID, REMOVED_AT);
  } finally {
    database.close(false);
  }
}

function seedMalformedTombstone(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const insert = database.prepare(
      'INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at) VALUES (?, ?, ?)',
    );
    database.transaction(() => {
      insert.run(worktreeId(0), snapshotId(0), REMOVED_AT);
      insert.run(worktreeId(1), Buffer.alloc(1_048_576, 7), REMOVED_AT);
      insert.run(worktreeId(2), snapshotId(2), Buffer.alloc(1_048_576, 9));
      insert.run(Buffer.alloc(1_048_576, 11), snapshotId(3), REMOVED_AT);
    })();
  } finally {
    database.close(false);
  }
}

function drainDueClaims(store: typeof CodeGraphStore.Service, databasePath: string, now: number) {
  return Effect.gen(function* () {
    const claimed: string[] = [];
    while (true) {
      const page = yield* store.claimRemovedViewCleanupCandidates(databasePath, now, 32);
      if (page.length === 0) return claimed;
      expect(page.length).toBeLessThanOrEqual(CODE_GRAPH_REMOVED_VIEW_CLEANUP_PAGE_ROWS);
      claimed.push(...page.map(entry => entry.worktreeId));
    }
  });
}

function readCleanupSurface(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const aggregate = database
      .query<
        {
          readonly count: number;
          readonly maximum: number | null;
          readonly minimum: number | null;
          readonly total: number | null;
        },
        []
      >(
        'SELECT COUNT(*) AS count, MIN(epoch) AS minimum, MAX(epoch) AS maximum, SUM(epoch) AS total FROM removed_view_cleanup',
      )
      .get()!;
    return {
      admissionCursor: metadataValue(database, 'removed_view_cleanup_admission_cursor'),
      epochCount: aggregate.count,
      epochMaximum: aggregate.maximum,
      epochMinimum: aggregate.minimum,
      epochSequence: metadataValue(database, 'removed_view_cleanup_epoch_sequence'),
      epochSum: aggregate.total,
      queueCount: aggregate.count,
      revision: metadataValue(database, 'persistent_extension_schema_revision'),
    };
  } finally {
    database.close(false);
  }
}

function metadataValue(database: Database, key: string): string | undefined {
  return database.query<{readonly value: string}, [string]>('SELECT value FROM schema_metadata WHERE key = ?').get(key)
    ?.value;
}

function readCleanupObjectNames(databasePath: string): readonly string[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly name: string}, []>(
        `SELECT name FROM sqlite_master
         WHERE name IN (
           'removed_view_cleanup', 'removed_view_cleanup_due',
           'removed_views_cleanup_revoke_delete', 'removed_views_cleanup_revoke_insert',
           'removed_views_cleanup_revoke_update'
         )
         ORDER BY name`,
      )
      .all()
      .map(row => row.name);
  } finally {
    database.close(false);
  }
}

function authorityDigest(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const hash = createHash('sha256');
    let activeRows = 0;
    let removedRows = 0;
    let snapshotRows = 0;
    for (const row of database
      .query<
        {readonly id: string; readonly repository_id: string; readonly state: string; readonly worktree_id: string},
        []
      >('SELECT id, repository_id, worktree_id, state FROM snapshots ORDER BY id')
      .iterate()) {
      snapshotRows += 1;
      hash.update(`snapshot\0${row.id}\0${row.repository_id}\0${row.worktree_id}\0${row.state}\n`);
    }
    for (const row of database
      .query<{readonly snapshot_id: string; readonly worktree_id: string}, []>(
        'SELECT worktree_id, snapshot_id FROM active_snapshots ORDER BY worktree_id',
      )
      .iterate()) {
      activeRows += 1;
      hash.update(`active\0${row.worktree_id}\0${row.snapshot_id}\n`);
    }
    for (const row of database
      .query<{readonly expected_snapshot_id: string; readonly removed_at: string; readonly worktree_id: string}, []>(
        'SELECT worktree_id, expected_snapshot_id, removed_at FROM removed_views ORDER BY worktree_id',
      )
      .iterate()) {
      removedRows += 1;
      hash.update(`removed\0${row.worktree_id}\0${row.expected_snapshot_id}\0${row.removed_at}\n`);
    }
    return {activeRows, digest: hash.digest('hex'), removedRows, snapshotRows};
  } finally {
    database.close(false);
  }
}

function corruptAdmissionFingerprint(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      cursor: metadataValue(database, 'removed_view_cleanup_admission_cursor'),
      queue: database.query('SELECT COUNT(*) AS count FROM removed_view_cleanup').get(),
      sequence: metadataValue(database, 'removed_view_cleanup_epoch_sequence'),
      tombstones: database
        .query(
          `SELECT COUNT(*) AS count,
                  SUM(length(CAST(worktree_id AS BLOB))) AS worktree_bytes,
                  SUM(length(CAST(expected_snapshot_id AS BLOB))) AS snapshot_bytes,
                  SUM(length(CAST(removed_at AS BLOB))) AS timestamp_bytes,
                  SUM(CASE WHEN typeof(worktree_id) <> 'text' THEN 1 ELSE 0 END) AS invalid_worktrees,
                  SUM(CASE WHEN typeof(expected_snapshot_id) <> 'text' THEN 1 ELSE 0 END) AS invalid_snapshots,
                  SUM(CASE WHEN typeof(removed_at) <> 'text' THEN 1 ELSE 0 END) AS invalid_timestamps
           FROM removed_views`,
        )
        .get(),
    };
  } finally {
    database.close(false);
  }
}

function checkpointDatabase(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
  } finally {
    database.close(false);
  }
}

function logLoadEvidence(evidence: Readonly<Record<string, unknown>>) {
  return Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  });
}

function observedFileSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function worktreeId(index: number): string {
  return index.toString(16).padStart(64, '0');
}

function snapshotId(index: number): string {
  return `cgsn_${index.toString(16).padStart(40, '0')}`;
}
