import {TestError} from '@threadnote/testing/test-error';
import {Array as EffectArray} from 'effect';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, DateTime, Effect, FileSystem, Path} from 'effect';
import {TestClock} from 'effect/testing';
import type {CodeGraphBuildStatus} from '@threadnote/graph/build_status';
import {
  CodeGraphMaintenanceCoordinator,
  type CodeGraphRoutineMaintenanceTick,
} from '@threadnote/graph/maintenance/coordinator';
import {
  CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL,
  CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL,
  CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL,
  CODE_GRAPH_VECTOR_REUSE_INDEX_SQL,
  CODE_GRAPH_VECTORS_TABLE_SQL,
} from '@threadnote/graph/vector/retirement';
import {codeGraphDiskReservationRoot, codeGraphLayout} from '@threadnote/graph/layout';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CODE_GRAPH_EXTRACTOR_GENERATION} from '@threadnote/graph/types';
import {removeCodeGraphView} from '@threadnote/graph/view_removal';
import {ApplicationLayer} from '@threadnote/threadnote/effect/runtime';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));
const REPOSITORY_ID = Effect2.pipe('b', EffectString.repeat(64));
const WORKTREE_ID = Effect2.pipe('c', EffectString.repeat(64));
const SNAPSHOT_ID = `cgsn_${Effect2.pipe('1', EffectString.repeat(40))}`;
const BUILD_ID = '11111111-1111-1111';
const PHASES = ['vector-pointers', 'build-status', 'provenance', 'complete'] as const;

interface CleanupRow {
  readonly attempts: number;
  readonly blocked_code: string | null;
  readonly cursor_token: string | null;
  readonly next_attempt_at: number;
  readonly phase: (typeof PHASES)[number];
  readonly revision: number;
}

describe('live removed-view residual maintenance', () => {
  effectIt.effect('reaches the production worker one durable unit per kick and preserves graph authority', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture('threadnote-residual-live-', {vector: true});
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const coordinator = yield* CodeGraphMaintenanceCoordinator;
        yield* seedExactTerminalBuildStatus(fs, path, fixture.home);
        const provenanceSidecar = yield* seedExactProvenance(fs, path, fixture.home);

        const foreground = yield* removeCodeGraphView(
          fixture.home,
          {
            checkoutId: CHECKOUT_ID,
            snapshotId: SNAPSHOT_ID,
            worktreeId: WORKTREE_ID,
          },
          {apply: true},
        );

        expect(foreground).toMatchObject({
          applied: true,
          cleanup: {provenance: {state: 'removed'}, vectors: null},
          state: 'removed',
          warnings: [],
        });
        expect(yield* fs.exists(provenanceSidecar)).toBe(false);
        expect(readVectorCounts(fixture.vectorDatabasePath!)).toMatchObject({pointers: 1});
        expect(readCleanupRow(fixture.databasePath)).toMatchObject({phase: 'vector-pointers', revision: 0});

        const observed = [readCleanupRow(fixture.databasePath)];
        const pointerCounts = [readVectorCounts(fixture.vectorDatabasePath!).pointers];
        let observedDurablePointerRetirement = false;
        let observedBuildSidecarRetirement = false;

        for (let unit = 0; unit < 16 && observed.at(-1)!.phase !== 'complete'; unit += 1) {
          const before = observed.at(-1)!;
          yield* advancePastCleanupSchedule(before);
          const result = yield* coordinator.kickResidual(fixture.tick);
          const after = readCleanupRow(fixture.databasePath);
          const pointerCount = readVectorCounts(fixture.vectorDatabasePath!).pointers;

          expect(result.state).toBe('completed');
          // Claiming takes one full-entry CAS revision. The bounded page may
          // either defer before its commit or take a second revision while
          // retaining the phase with a durable progress cursor.
          const revisionDelta = after.revision - before.revision;
          expect(revisionDelta).toBeGreaterThanOrEqual(1);
          expect(revisionDelta).toBeLessThanOrEqual(2);
          if (revisionDelta === 1) {
            expect(after.phase).toBe(before.phase);
          }
          expect(PHASES.indexOf(after.phase) - PHASES.indexOf(before.phase)).toBeGreaterThanOrEqual(0);
          expect(PHASES.indexOf(after.phase) - PHASES.indexOf(before.phase)).toBeLessThanOrEqual(1);
          expect(yield* activeReceiptCount(fs, path, fixture.home)).toBe(0);

          observed.push(after);
          pointerCounts.push(pointerCount);
          if (pointerCount === 0 && before.phase === 'vector-pointers' && after.phase === 'vector-pointers') {
            observedDurablePointerRetirement = true;
          }
          if (!buildStatusExists(fixture.home) && before.phase === 'build-status' && after.phase === 'build-status') {
            observedBuildSidecarRetirement = true;
          }

          // A direct kick has no detached tail. A caller may stop here and a
          // later process can resume from the stored cursor and revision.
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(readCleanupRow(fixture.databasePath)).toEqual(after);
        }

        expect(observed.at(-1)).toMatchObject({
          attempts: 0,
          blocked_code: null,
          cursor_token: null,
          phase: 'complete',
        });
        expect(new Set(EffectArray.map(observed, row => row.phase))).toEqual(new Set(PHASES));
        expect(observedDurablePointerRetirement).toBe(true);
        expect(observedBuildSidecarRetirement).toBe(true);
        expect(pointerCounts[0]).toBe(1);
        expect(pointerCounts.at(-1)).toBe(0);
        expect(
          EffectArray.every(pointerCounts, (count, index) => index === 0 || count <= pointerCounts[index - 1]),
        ).toBe(true);
        const completedVectorState = readVectorCounts(fixture.vectorDatabasePath!);
        expect(completedVectorState).toEqual({generations: 0, pointers: 0, retirements: 0, vectors: 0});
        expect(buildStatusExists(fixture.home)).toBe(false);
        expect(readAuthority(fixture.databasePath)).toEqual({
          active: [],
          cleanup: [{expected_snapshot_id: SNAPSHOT_ID, phase: 'complete', worktree_id: WORKTREE_ID}],
          removed: [{expected_snapshot_id: SNAPSHOT_ID, worktree_id: WORKTREE_ID}],
        });

        const completed = readCleanupRow(fixture.databasePath);
        yield* coordinator.kickResidual(fixture.tick);
        expect(readCleanupRow(fixture.databasePath)).toEqual(completed);
        expect(readVectorCounts(fixture.vectorDatabasePath!)).toEqual(completedVectorState);

        // The normal lane composition is also reachable through the same live
        // ApplicationLayer without changing completed residual authority.
        yield* TestClock.adjust(2);
        expect((yield* coordinator.tick(fixture.tick)).state).toBe('completed');
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(readCleanupRow(fixture.databasePath)).toEqual(completed);
        expect(readAuthority(fixture.databasePath).removed).toEqual([
          {expected_snapshot_id: SNAPSHOT_ID, worktree_id: WORKTREE_ID},
        ]);
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );

  effectIt.effect('defers invalid and legacy provenance with a durable invalid-sidecar cooldown', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const coordinator = yield* CodeGraphMaintenanceCoordinator;

        for (const provenance of ['invalid', 'legacy-v1'] as const) {
          const fixture = yield* makeFixture(`threadnote-residual-${provenance}-`, {vector: false});
          yield* seedPoisonProvenance(fs, path, fixture.home, provenance);
          const store = yield* CodeGraphStore;
          expect(
            yield* store.removeView(fixture.databasePath, WORKTREE_ID, SNAPSHOT_ID, {
              cleanupEvidence: {
                recordDigest: Effect2.pipe('d', EffectString.repeat(64)),
                recordIdentity: Effect2.pipe('e', EffectString.repeat(64)),
                repositoryId: REPOSITORY_ID,
              },
            }),
          ).toMatchObject({state: 'removed'});

          let afterVector = readCleanupRow(fixture.databasePath);
          for (let attempt = 0; attempt < 16 && afterVector.phase === 'vector-pointers'; attempt += 1) {
            const before = afterVector;
            yield* advancePastCleanupSchedule(before);
            expect((yield* coordinator.kickResidual(fixture.tick)).state).toBe('completed');
            afterVector = readCleanupRow(fixture.databasePath);
            const revisionDelta = afterVector.revision - before.revision;
            expect(revisionDelta).toBeGreaterThanOrEqual(1);
            expect(revisionDelta).toBeLessThanOrEqual(2);
            if (revisionDelta === 1) expect(afterVector.phase).toBe(before.phase);
          }
          expect(afterVector.phase).toBe('build-status');

          yield* advancePastCleanupSchedule(afterVector);
          yield* coordinator.kickResidual(fixture.tick);
          const afterBuildStatus = readCleanupRow(fixture.databasePath);
          expect(afterBuildStatus).toMatchObject({
            phase: 'provenance',
            revision: afterVector.revision + 2,
          });

          yield* advancePastCleanupSchedule(afterBuildStatus);
          yield* coordinator.kickResidual(fixture.tick);
          const deferred = readCleanupRow(fixture.databasePath);
          expect(deferred).toMatchObject({
            attempts: 1,
            blocked_code: 'invalid-sidecar',
            cursor_token: null,
            phase: 'provenance',
            revision: afterBuildStatus.revision + 2,
          });

          // The persisted retry timestamp prevents an immediate hot retry.
          yield* coordinator.kickResidual(fixture.tick);
          expect(readCleanupRow(fixture.databasePath)).toEqual(deferred);
          expect(readAuthority(fixture.databasePath)).toEqual({
            active: [],
            cleanup: [{expected_snapshot_id: SNAPSHOT_ID, phase: 'provenance', worktree_id: WORKTREE_ID}],
            removed: [{expected_snapshot_id: SNAPSHOT_ID, worktree_id: WORKTREE_ID}],
          });
        }
      }),
    ).pipe(provideTestLayer(ApplicationLayer)),
  );
});

const advancePastCleanupSchedule = Effect.fn('test.advancePastCleanupSchedule')(function* (row: CleanupRow) {
  const now = yield* Clock.currentTimeMillis;
  yield* TestClock.adjust(Math.max(2, row.next_attempt_at - now + 1));
});

function makeFixture(prefix: string, options: {readonly vector: boolean}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* CodeGraphStore;
    const temporaryHome = yield* fs.makeTempDirectoryScoped({prefix});
    const home = yield* fs.realPath(temporaryHome);
    const layout = codeGraphLayout(path, home, CHECKOUT_ID, WORKTREE_ID);
    yield* store.initialize(layout.databasePath);
    yield* Effect.sync(() => seedGraph(layout.databasePath));
    yield* store.acquireSnapshotLease(layout.databasePath, SNAPSHOT_ID, 60_000);
    const vectorDatabasePath = options.vector ? yield* seedVectorDatabase(fs, path, home) : undefined;
    return {
      databasePath: layout.databasePath,
      home,
      tick: {
        checkoutId: CHECKOUT_ID,
        databasePath: layout.databasePath,
        threadnoteHome: home,
        writerLockPath: layout.databaseWriteLockPath,
      } satisfies CodeGraphRoutineMaintenanceTick,
      vectorDatabasePath,
    };
  });
}

function seedGraph(databasePath: string): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, 'threadnote/residual-live', 'sha1', ?, ?)`,
      )
      .run(REPOSITORY_ID, new Date(0).toISOString(), new Date(0).toISOString());
    database
      .query(
        `INSERT INTO snapshots (
           id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
           dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
           failure_summary
         ) VALUES (?, ?, ?, ?, 'content-residual-live', NULL, 'residual-live-test', 0, NULL, 'ready',
                   0, 0, 0, ?, ?, NULL)`,
      )
      .run(
        SNAPSHOT_ID,
        REPOSITORY_ID,
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

function seedVectorDatabase(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return Effect.gen(function* () {
    const modelRoot = path.join(home, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'vectors', 'model-live');
    yield* fs.makeDirectory(modelRoot, {recursive: true, mode: 0o700});
    const databasePath = path.join(modelRoot, 'vectors-v2.sqlite');
    yield* Effect.sync(() => {
      const database = new Database(databasePath, {create: true, strict: true});
      try {
        database.exec(`
          PRAGMA foreign_keys = ON;
          PRAGMA user_version = 2;
          ${CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL};
          ${CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL};
          ${CODE_GRAPH_VECTOR_POINTER_GENERATION_INDEX_SQL};
          ${CODE_GRAPH_VECTORS_TABLE_SQL};
          ${CODE_GRAPH_VECTOR_REUSE_INDEX_SQL};
        `);
        database
          .query(
            `INSERT INTO vector_generations (
               generation, snapshot_id, model_id, model_sha256, dimensions,
               template_version, count, state, created_at
             ) VALUES (?, ?, 'model-live', ?, 384, 1, 0, 'ready', ?)`,
          )
          .run(
            'generation-live',
            SNAPSHOT_ID,
            Effect2.pipe('9', EffectString.repeat(64)),
            DateTime.formatIso(DateTime.makeUnsafe(0)),
          );
        database
          .query('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)')
          .run(WORKTREE_ID, 'generation-live');
      } finally {
        database.close(false);
      }
    });
    return databasePath;
  });
}

function seedExactTerminalBuildStatus(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return Effect.gen(function* () {
    const directory = path.join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      CHECKOUT_ID,
      'build-status',
      WORKTREE_ID,
    );
    yield* fs.makeDirectory(directory, {recursive: true, mode: 0o700});
    const status = terminalBuildStatus();
    yield* fs.writeFileString(path.join(directory, `${BUILD_ID}.json`), `${JSON.stringify(status)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    yield* fs.writeFileString(
      path.join(directory, `${BUILD_ID}.manager-context`),
      `${JSON.stringify({buildId: BUILD_ID, schemaVersion: 1, worktreePath: '/private/missing-worktree'})}\n`,
      {flag: 'wx', mode: 0o600},
    );
  });
}

function seedExactProvenance(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return Effect.gen(function* () {
    const localContext = path.join(home, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'local-context');
    const worktrees = path.join(localContext, 'worktrees');
    yield* fs.makeDirectory(worktrees, {recursive: true, mode: 0o700});
    if (process.platform !== 'win32') {
      yield* fs.chmod(localContext, 0o700);
      yield* fs.chmod(worktrees, 0o700);
    }
    const sidecar = path.join(worktrees, `${WORKTREE_ID}.json`);
    yield* fs.writeFileString(
      sidecar,
      `${JSON.stringify({
        canonicalWorktreePath: path.join(home, 'missing-worktree'),
        checkoutId: CHECKOUT_ID,
        headCommit: Effect2.pipe('f', EffectString.repeat(40)),
        observedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
        registration: {kind: 'main'},
        repositoryId: REPOSITORY_ID,
        schemaVersion: 2,
        worktreeId: WORKTREE_ID,
      })}\n`,
      {flag: 'wx', mode: 0o600},
    );
    return sidecar;
  });
}

function terminalBuildStatus(): CodeGraphBuildStatus {
  const timestamp = new Date(0).toISOString();
  return {
    buildId: BUILD_ID,
    counters: {},
    identity: {
      checkoutId: CHECKOUT_ID,
      commit: Effect2.pipe('f', EffectString.repeat(40)),
      repositoryId: REPOSITORY_ID,
      worktreeId: WORKTREE_ID,
    },
    owner: {processId: 42, runtime: 'bun', runtimeVersion: '1.3.14'},
    phase: 'materializing',
    result: {dirty: false, edges: 0, files: 0, snapshotId: SNAPSHOT_ID, symbols: 0},
    schemaVersion: 1,
    state: 'completed',
    timestamps: {
      completedAt: timestamp,
      heartbeatAt: timestamp,
      lastProgressAt: timestamp,
      phaseStartedAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function seedPoisonProvenance(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  home: string,
  provenance: 'invalid' | 'legacy-v1',
) {
  return Effect.gen(function* () {
    const localContext = path.join(home, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'local-context');
    const worktrees = path.join(localContext, 'worktrees');
    yield* fs.makeDirectory(worktrees, {recursive: true, mode: 0o700});
    if (process.platform !== 'win32') {
      yield* fs.chmod(localContext, 0o700);
      yield* fs.chmod(worktrees, 0o700);
    }
    const content =
      provenance === 'invalid'
        ? {}
        : {
            canonicalWorktreePath: path.join(home, 'missing-worktree'),
            checkoutId: CHECKOUT_ID,
            headCommit: Effect2.pipe('f', EffectString.repeat(40)),
            observedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
            repositoryId: REPOSITORY_ID,
            schemaVersion: 1,
            worktreeId: WORKTREE_ID,
          };
    yield* fs.writeFileString(path.join(worktrees, `${WORKTREE_ID}.json`), `${JSON.stringify(content)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  });
}

function readCleanupRow(databasePath: string): CleanupRow {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<CleanupRow, [string, string]>(
        `SELECT phase, cursor_token, revision, attempts, next_attempt_at, blocked_code
         FROM removed_view_cleanup
         WHERE worktree_id = ? AND expected_snapshot_id = ?`,
      )
      .get(WORKTREE_ID, SNAPSHOT_ID)!;
  } finally {
    database.close(false);
  }
}

function readAuthority(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return {
      active: database
        .query('SELECT worktree_id, snapshot_id FROM active_snapshots WHERE worktree_id = ?')
        .all(WORKTREE_ID),
      cleanup: database
        .query(
          `SELECT worktree_id, expected_snapshot_id, phase
           FROM removed_view_cleanup WHERE worktree_id = ?`,
        )
        .all(WORKTREE_ID),
      removed: database
        .query(
          `SELECT worktree_id, expected_snapshot_id
           FROM removed_views WHERE worktree_id = ?`,
        )
        .all(WORKTREE_ID),
    };
  } finally {
    database.close(false);
  }
}

function readVectorCounts(databasePath: string) {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    const hasTable = (table: string) =>
      Number(
        requiredRow(
          database
            .query<
              {
                readonly count: number;
              },
              SQLQueryBindings[]
            >("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get(table),
        ).count,
      ) === 1;
    const count = (table: string) =>
      Number(
        requiredRow(
          database.query<{readonly count: number}, SQLQueryBindings[]>(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        ).count,
      );
    return {
      generations: count('vector_generations'),
      pointers: count('vector_pointers'),
      retirements: hasTable('vector_generation_retirements') ? count('vector_generation_retirements') : 0,
      vectors: count('vectors'),
    };
  } finally {
    database.close(false);
  }
}

function buildStatusExists(home: string): boolean {
  const file = `${home}/indexes/code-graph/repositories/${CHECKOUT_ID}/build-status/${WORKTREE_ID}/${BUILD_ID}.json`;
  return Bun.file(file).size > 0;
}

function activeReceiptCount(fs: FileSystem.FileSystem, path: Path.Path, home: string) {
  return Effect.gen(function* () {
    const root = codeGraphDiskReservationRoot(path, home);
    if (!(yield* fs.exists(root))) return 0;
    return EffectArray.filter(
      yield* fs.readDirectory(root),
      __effectArrayValue => !!(name => /^v1-[0-9a-f]{64}\.json$/u.test(name))(__effectArrayValue),
    ).length;
  });
}
