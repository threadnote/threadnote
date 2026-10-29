import {Array as EffectArray} from 'effect';
import {TestCommandExecutorLayer} from '../helpers/system-layer.js';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Crypto, Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import fc from 'fast-check';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {codeGraphVectorWriteLockPath} from '@threadnote/graph/layout';
import {observeCodeGraphMaintenanceStatus} from '@threadnote/graph/maintenance/gate';
import {
  codeGraphSnapshotPurgeApprovalDigest,
  purgeCodeGraphSnapshot,
  type CodeGraphSnapshotPurgeApprovalProjection,
} from '@threadnote/graph/snapshot/purge';
import {CodeGraphStore} from '@threadnote/graph/store';
import {CODE_GRAPH_EXTRACTOR_GENERATION} from '@threadnote/graph/types';
import {prepareCodeGraphVectorRetirement} from '@threadnote/graph/vector/maintenance';

import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import {SystemInfo} from '@threadnote/platform/system';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));
const REPOSITORY_ID = Effect2.pipe('b', EffectString.repeat(64));
const WORKTREE_ID = Effect2.pipe('1', EffectString.repeat(64));
const SNAPSHOT_ID = `cgsn_${Effect2.pipe('c', EffectString.repeat(40))}-direct`;
const OTHER_SNAPSHOT_ID = `cgsn_${Effect2.pipe('d', EffectString.repeat(40))}-direct`;

const SnapshotPurgeTestLayer = Layer.merge(CodeGraphStore.layer, TestCommandExecutorLayer).pipe(
  Layer.provideMerge(TestSystemInfoLayer),
  Layer.provideMerge(BunServices.layer),
);

describe('code graph selected snapshot purge', () => {
  effectIt.layer(SnapshotPurgeTestLayer)(layerIt => {
    layerIt.effect('previews without mutation and applies only the exact approved isolated snapshot', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* snapshotPurgeFixture();
          const preview = yield* purgeCodeGraphSnapshot(fixture.home, {
            checkoutId: CHECKOUT_ID,
            snapshotId: SNAPSHOT_ID,
          });

          expect(preview).toMatchObject({
            applied: false,
            blockers: [],
            eligible: true,
            state: 'ready',
          });
          expect(preview.approvalDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
          expect(readSnapshotState(fixture.databasePath, SNAPSHOT_ID)).toBe('ready');
          expect(readSnapshotState(fixture.databasePath, OTHER_SNAPSHOT_ID)).toBe('ready');

          const applied = yield* purgeCodeGraphSnapshot(
            fixture.home,
            {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID},
            {apply: true, approvalDigest: preview.approvalDigest},
          );

          expect(applied).toMatchObject({applied: true, blockers: [], eligible: true});
          expect(['purged', 'retired']).toContain(applied.state);
          expect(readSnapshotState(fixture.databasePath, SNAPSHOT_ID)).not.toBe('ready');
          expect(readSnapshotState(fixture.databasePath, OTHER_SNAPSHOT_ID)).toBe('ready');
        }),
      ),
    );

    layerIt.effect('reports every structural blocker in deterministic order and never mutates on preview', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* snapshotPurgeFixture({
            active: true,
            alias: true,
            buildOwned: true,
            child: true,
            cleanupPending: true,
            leased: true,
          });

          const preview = yield* purgeCodeGraphSnapshot(fixture.home, {
            checkoutId: CHECKOUT_ID,
            snapshotId: SNAPSHOT_ID,
          });

          expect(preview.eligible).toBe(false);
          expect(preview.state).toBe('blocked');
          expect(EffectArray.map(preview.blockers, blocker => blocker.code)).toEqual([
            'active-view',
            'alias-snapshot',
            'base-required',
            'build-owned',
            'cleanup-pending',
            'live-lease',
          ]);
          expect(readSnapshotState(fixture.databasePath, SNAPSHOT_ID)).toBe('ready');
        }),
      ),
    );

    layerIt.effect('rejects an approval when safety evidence changes before the gated apply', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* snapshotPurgeFixture();
          const preview = yield* purgeCodeGraphSnapshot(fixture.home, {
            checkoutId: CHECKOUT_ID,
            snapshotId: SNAPSHOT_ID,
          });
          if (preview.approvalDigest === undefined) throw TestError.make({message: 'expected approval digest'});

          const result = yield* purgeCodeGraphSnapshot(
            fixture.home,
            {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID},
            {
              afterMaintenanceGates: () =>
                Effect.gen(function* () {
                  insertLease(fixture.databasePath, SNAPSHOT_ID, (yield* Clock.currentTimeMillis) + 60_000);
                }),
              apply: true,
              approvalDigest: preview.approvalDigest,
            },
          );

          expect(result).toMatchObject({applied: false, state: 'state-changed'});
          expect(readSnapshotState(fixture.databasePath, SNAPSHOT_ID)).toBe('ready');
          expect(readSnapshotState(fixture.databasePath, OTHER_SNAPSHOT_ID)).toBe('ready');
        }),
      ),
    );

    layerIt.effect('blocks a snapshot with an active vector pointer but permits inactive vector generations', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const activeFixture = yield* snapshotPurgeFixture();
          yield* seedSnapshotVectorDatabase(activeFixture.home, true);
          const active = yield* purgeCodeGraphSnapshot(activeFixture.home, {
            checkoutId: CHECKOUT_ID,
            snapshotId: SNAPSHOT_ID,
          });
          expect(active).toMatchObject({applied: false, eligible: false, state: 'blocked'});
          expect(EffectArray.map(active.blockers, blocker => blocker.code)).toEqual(['vector-active']);
          expect(readSnapshotState(activeFixture.databasePath, SNAPSHOT_ID)).toBe('ready');

          const inactiveFixture = yield* snapshotPurgeFixture();
          yield* seedSnapshotVectorDatabase(inactiveFixture.home, false);
          const inactive = yield* purgeCodeGraphSnapshot(inactiveFixture.home, {
            checkoutId: CHECKOUT_ID,
            snapshotId: SNAPSHOT_ID,
          });
          expect(inactive).toMatchObject({eligible: true, state: 'ready'});
          expect(inactive.evidence?.vectorGenerationCount).toBe(1);
        }),
      ),
    );

    layerIt.effect('invalidates approval when a vector pointer appears under the final gates', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* snapshotPurgeFixture();
          const vectorDatabase = yield* seedSnapshotVectorDatabase(fixture.home, false);
          const preview = yield* purgeCodeGraphSnapshot(fixture.home, {
            checkoutId: CHECKOUT_ID,
            snapshotId: SNAPSHOT_ID,
          });
          if (preview.approvalDigest === undefined) throw TestError.make({message: 'expected approval digest'});

          const result = yield* purgeCodeGraphSnapshot(
            fixture.home,
            {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID},
            {
              afterMaintenanceGates: () =>
                Effect.sync(() => {
                  const database = new Database(vectorDatabase, {strict: true});
                  try {
                    database
                      .query('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)')
                      .run(Effect2.pipe('4', EffectString.repeat(64)), 'generation-target');
                  } finally {
                    database.close(false);
                  }
                }),
              apply: true,
              approvalDigest: preview.approvalDigest,
            },
          );

          expect(result).toMatchObject({applied: false, state: 'state-changed'});
          expect(EffectArray.map(result.blockers, blocker => blocker.code)).toEqual(['vector-active']);
          expect(readSnapshotState(fixture.databasePath, SNAPSHOT_ID)).toBe('ready');
        }),
      ),
    );

    layerIt.effect('fails closed for an unsafe vector inventory', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* snapshotPurgeFixture();
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const vectorRoot = path.join(fixture.home, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'vectors');
          yield* fs.makeDirectory(vectorRoot, {recursive: true, mode: 0o700});
          yield* fs.writeFileString(path.join(vectorRoot, 'unsafe inventory entry!'), 'preserve\n');

          const preview = yield* purgeCodeGraphSnapshot(fixture.home, {
            checkoutId: CHECKOUT_ID,
            snapshotId: SNAPSHOT_ID,
          });

          expect(preview).toMatchObject({applied: false, eligible: false, state: 'blocked'});
          expect(EffectArray.map(preview.blockers, blocker => blocker.code)).toEqual(['vector-unverifiable']);
          expect(readSnapshotState(fixture.databasePath, SNAPSHOT_ID)).toBe('ready');
        }),
      ),
    );

    layerIt.effect('fails immediately behind a vector writer and preserves the approved snapshot', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* snapshotPurgeFixture();
          yield* seedSnapshotVectorDatabase(fixture.home, false);
          const preview = yield* purgeCodeGraphSnapshot(fixture.home, {
            checkoutId: CHECKOUT_ID,
            snapshotId: SNAPSHOT_ID,
          });
          if (preview.approvalDigest === undefined) throw TestError.make({message: 'expected approval digest'});

          const crypto = yield* Crypto.Crypto;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const acquired = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const owner = yield* withExclusiveFileLock(
            fs,
            codeGraphVectorWriteLockPath(path, fixture.home, CHECKOUT_ID, sha256HexSync('snapshot-purge-model')),
            {
              onAcquired: () => Deferred.succeed(acquired, undefined).pipe(Effect.asVoid),
              retryIntervalMilliseconds: 5,
              staleAfterMilliseconds: 120_000,
              waitTimeoutMilliseconds: 5_000,
            },
            Deferred.await(release),
          ).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
            Effect.forkChild,
          );
          yield* Deferred.await(acquired);
          const outcome = yield* purgeCodeGraphSnapshot(
            fixture.home,
            {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID},
            {apply: true, approvalDigest: preview.approvalDigest},
          ).pipe(Effect.exit);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(owner);

          expect(outcome._tag).toBe('Failure');
          if (outcome._tag === 'Failure') expect(String(outcome.cause)).toContain('CodeGraphStoreBusyError');
          expect(readSnapshotState(fixture.databasePath, SNAPSHOT_ID)).toBe('ready');
        }),
      ),
    );

    layerIt.effect('never advances cleanup for an unrelated retired snapshot', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* snapshotPurgeFixture();
          setSnapshotState(fixture.databasePath, OTHER_SNAPSHOT_ID, 'retired');
          const preview = yield* purgeCodeGraphSnapshot(fixture.home, {
            checkoutId: CHECKOUT_ID,
            snapshotId: SNAPSHOT_ID,
          });
          if (preview.approvalDigest === undefined) throw TestError.make({message: 'expected approval digest'});
          yield* purgeCodeGraphSnapshot(
            fixture.home,
            {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID},
            {apply: true, approvalDigest: preview.approvalDigest},
          );

          expect(readSnapshotState(fixture.databasePath, OTHER_SNAPSHOT_ID)).toBe('retired');
          expect(snapshotExtractorGenerationCount(fixture.databasePath, OTHER_SNAPSHOT_ID)).toBe(1);
        }),
      ),
    );

    layerIt.effect('publishes the current gated phase for Manager polling and removes it on completion', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* snapshotPurgeFixture();
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const system = yield* SystemInfo;
          const observeMaintenance = observeCodeGraphMaintenanceStatus(fixture.home).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(SystemInfo, system),
          );
          const preview = yield* purgeCodeGraphSnapshot(fixture.home, {
            checkoutId: CHECKOUT_ID,
            snapshotId: SNAPSHOT_ID,
          });
          if (preview.approvalDigest === undefined) throw TestError.make({message: 'expected approval digest'});
          let observed: unknown;
          yield* purgeCodeGraphSnapshot(
            fixture.home,
            {checkoutId: CHECKOUT_ID, snapshotId: SNAPSHOT_ID},
            {
              afterMaintenanceGates: () =>
                observeMaintenance.pipe(
                  Effect.tap(status =>
                    Effect.sync(() => {
                      observed = status;
                    }),
                  ),
                  Effect.asVoid,
                ),
              apply: true,
              approvalDigest: preview.approvalDigest,
            },
          );

          expect(observed).toMatchObject({
            checkoutId: CHECKOUT_ID,
            completed: 3,
            operation: 'selected-snapshot-purge',
            phase: 'verifying-graph',
            snapshotId: SNAPSHOT_ID,
            total: 5,
          });
          expect(JSON.stringify(observed)).not.toContain(fixture.home);
          expect(yield* observeMaintenance).toBeUndefined();
        }),
      ),
    );
  });

  fcEffectProp(
    effectIt,
    'canonical approval is insertion-order independent and safety-field sensitive',
    {
      activeViews: fc.uniqueArray(hexString(64), {maxLength: 8}),
      childSnapshots: fc.uniqueArray(hexString(40), {maxLength: 8}),
      leaseExpiries: fc.uniqueArray(fc.integer({max: 2_000_000_000_000, min: 1}), {maxLength: 8}),
    },
    ({activeViews, childSnapshots, leaseExpiries}) =>
      Effect.sync(() => {
        const projection = approvalProjection(activeViews, childSnapshots, leaseExpiries);
        const reversed: CodeGraphSnapshotPurgeApprovalProjection = {
          ...projection,
          activeViewIds: [...projection.activeViewIds].reverse(),
          childSnapshotIds: [...projection.childSnapshotIds].reverse(),
          liveLeases: [...projection.liveLeases].reverse(),
        };
        const digest = codeGraphSnapshotPurgeApprovalDigest(projection);
        expect(codeGraphSnapshotPurgeApprovalDigest(reversed)).toBe(digest);
        expect(
          codeGraphSnapshotPurgeApprovalDigest({
            ...projection,
            snapshot: {...projection.snapshot, edgeCount: projection.snapshot.edgeCount + 1},
          }),
        ).not.toBe(digest);
      }),
    {fastCheck: {numRuns: 40}},
  );
});

function hexString(length: number): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...'0123456789abcdef'), {maxLength: length, minLength: length})
    .map(value => EffectArray.join(value, ''));
}

interface FixtureOptions {
  readonly active?: boolean;
  readonly alias?: boolean;
  readonly buildOwned?: boolean;
  readonly child?: boolean;
  readonly cleanupPending?: boolean;
  readonly leased?: boolean;
}

function snapshotPurgeFixture(options: FixtureOptions = {}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* CodeGraphStore;
    const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-snapshot-purge-'});
    const databasePath = path.join(home, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'graph-v3.sqlite');
    yield* store.initialize(databasePath);
    yield* Effect.sync(() => seedGraph(databasePath, options));
    return {databasePath, home};
  });
}

function seedSnapshotVectorDatabase(home: string, active: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const modelRoot = path.join(
      home,
      'indexes',
      'code-graph',
      'repositories',
      CHECKOUT_ID,
      'vectors',
      'snapshot-purge-model',
    );
    yield* fs.makeDirectory(modelRoot, {recursive: true, mode: 0o700});
    const databasePath = path.join(modelRoot, 'vectors-v2.sqlite');
    yield* Effect.sync(() => createSnapshotVectorDatabase(databasePath, active));
    for (let step = 0; step < 4; step += 1) {
      const prepared = yield* prepareCodeGraphVectorRetirement(databasePath, {
        capacityProtector: (_boundary, transaction) => transaction,
      });
      if (prepared.state === 'ready') return databasePath;
    }
    return yield* Effect.die(TestError.make({message: 'Vector retirement schema did not become ready.'}));
  });
}

function createSnapshotVectorDatabase(databasePath: string, active: boolean): void {
  const database = new Database(databasePath, {create: true, strict: true});
  try {
    database.run('PRAGMA foreign_keys = ON');
    database.run('PRAGMA user_version = 2');
    database.run(`CREATE TABLE vector_generations (
      generation TEXT PRIMARY KEY,
      snapshot_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_sha256 TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK(dimensions > 0),
      template_version INTEGER NOT NULL,
      count INTEGER NOT NULL CHECK(count >= 0),
      state TEXT NOT NULL CHECK(state IN ('building', 'ready')),
      created_at TEXT NOT NULL
    )`);
    database.run(`CREATE TABLE vector_pointers (
      worktree_id TEXT PRIMARY KEY,
      generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE
    )`);
    database.run('CREATE INDEX vector_pointer_generation_lookup ON vector_pointers (generation)');
    database.run(`CREATE TABLE vectors (
      generation TEXT NOT NULL REFERENCES vector_generations(generation) ON DELETE CASCADE,
      symbol_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      vector BLOB NOT NULL,
      PRIMARY KEY (generation, symbol_id)
    ) WITHOUT ROWID`);
    database.run('CREATE INDEX vector_reuse_lookup ON vectors (generation, symbol_id, fingerprint)');
    database
      .query(
        `INSERT INTO vector_generations
         (generation, snapshot_id, model_id, model_sha256, dimensions, template_version, count, state, created_at)
         VALUES ('generation-target', ?, 'snapshot-purge-model', ?, 3, 1, 0, 'ready', ?)`,
      )
      .run(SNAPSHOT_ID, Effect2.pipe('f', EffectString.repeat(64)), new Date(0).toISOString());
    if (active) {
      database
        .query("INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, 'generation-target')")
        .run(Effect2.pipe('4', EffectString.repeat(64)));
    }
  } finally {
    database.close(false);
  }
}

function seedGraph(databasePath: string, options: FixtureOptions): void {
  const database = new Database(databasePath, {strict: true});
  try {
    const started = new Date(0).toISOString();
    const completed = new Date(1).toISOString();
    database
      .query(
        `INSERT INTO repositories (id, display_name, object_format, created_at, last_used_at)
         VALUES (?, 'threadnote/snapshot-purge', 'sha1', ?, ?)`,
      )
      .run(REPOSITORY_ID, started, started);
    const insertSnapshot = database.prepare(
      `INSERT INTO snapshots (
         id, repository_id, worktree_id, commit_id, graph_content_id, base_snapshot_id, extractor_set,
         dirty, overlay_fingerprint, state, file_count, symbol_count, edge_count, started_at, completed_at,
         failure_summary
       ) VALUES (?, ?, ?, ?, ?, ?, 'snapshot-purge-test', 0, NULL, 'ready', 0, 0, 0, ?, ?, NULL)`,
    );
    insertSnapshot.run(
      SNAPSHOT_ID,
      REPOSITORY_ID,
      WORKTREE_ID,
      Effect2.pipe('f', EffectString.repeat(40)),
      'content-target',
      options.alias ? OTHER_SNAPSHOT_ID : null,
      started,
      completed,
    );
    insertSnapshot.run(
      OTHER_SNAPSHOT_ID,
      REPOSITORY_ID,
      Effect2.pipe('2', EffectString.repeat(64)),
      Effect2.pipe('e', EffectString.repeat(40)),
      'content-other',
      null,
      started,
      completed,
    );
    database
      .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
      .run(SNAPSHOT_ID, CODE_GRAPH_EXTRACTOR_GENERATION);
    database
      .query('INSERT INTO snapshot_extractor_generations (snapshot_id, generation) VALUES (?, ?)')
      .run(OTHER_SNAPSHOT_ID, CODE_GRAPH_EXTRACTOR_GENERATION);
    if (options.active) {
      database
        .query('INSERT INTO active_snapshots (worktree_id, snapshot_id, activated_at) VALUES (?, ?, ?)')
        .run(WORKTREE_ID, SNAPSHOT_ID, completed);
    }
    if (options.child) {
      database.query('UPDATE snapshots SET base_snapshot_id = ? WHERE id = ?').run(SNAPSHOT_ID, OTHER_SNAPSHOT_ID);
    }
    if (options.leased) insertLease(databasePath, SNAPSHOT_ID, Date.now() + 60_000, database);
    if (options.buildOwned) {
      database
        .query('INSERT INTO snapshot_build_owners (snapshot_id, owner_token, claimed_at) VALUES (?, ?, ?)')
        .run(SNAPSHOT_ID, 'owner:1', completed);
    }
    if (options.cleanupPending) {
      database
        .query(`INSERT INTO removed_views (worktree_id, expected_snapshot_id, removed_at) VALUES (?, ?, ?)`)
        .run(Effect2.pipe('3', EffectString.repeat(64)), SNAPSHOT_ID, completed);
      database
        .query(
          `INSERT INTO removed_view_cleanup (
             worktree_id, expected_snapshot_id, removed_at, epoch, phase, cursor_token, attempts,
             blocked_code, next_attempt_at, revision, updated_at
           ) VALUES (?, ?, ?, 1, 'vector-pointers', NULL, 0, NULL, 0, 0, ?)`,
        )
        .run(Effect2.pipe('3', EffectString.repeat(64)), SNAPSHOT_ID, completed, completed);
    }
  } finally {
    database.close(false);
  }
}

function insertLease(databasePath: string, snapshotId: string, expiresAt: number, existingDatabase?: Database): void {
  const database = existingDatabase ?? new Database(databasePath, {strict: true});
  try {
    database
      .query(
        `INSERT INTO snapshot_leases (token, snapshot_id, expires_at, retire_when_inactive)
         VALUES (?, ?, ?, 0)`,
      )
      .run(`lease-${expiresAt}`, snapshotId, expiresAt);
  } finally {
    if (existingDatabase === undefined) database.close(false);
  }
}

function readSnapshotState(databasePath: string, snapshotId: string): string | undefined {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly state: string}, [string]>('SELECT state FROM snapshots WHERE id = ?')
      .get(snapshotId)?.state;
  } finally {
    database.close(false);
  }
}

function setSnapshotState(databasePath: string, snapshotId: string, state: 'retired'): void {
  const database = new Database(databasePath, {strict: true});
  try {
    database.query('UPDATE snapshots SET state = ? WHERE id = ?').run(state, snapshotId);
  } finally {
    database.close(false);
  }
}

function snapshotExtractorGenerationCount(databasePath: string, snapshotId: string): number {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return Number(
      database
        .query<{readonly count: number}, [string]>(
          'SELECT COUNT(*) AS count FROM snapshot_extractor_generations WHERE snapshot_id = ?',
        )
        .get(snapshotId)?.count ?? 0,
    );
  } finally {
    database.close(false);
  }
}

function approvalProjection(
  activeViews: readonly string[],
  childSnapshots: readonly string[],
  leaseExpiries: readonly number[],
): CodeGraphSnapshotPurgeApprovalProjection {
  return {
    activeViewIds: activeViews,
    buildOwnerIds: [],
    childSnapshotIds: EffectArray.map(childSnapshots, value => `cgsn_${value}`),
    cleanupEpochs: [],
    graphEvidenceDigest: Effect2.pipe('1', EffectString.repeat(64)),
    liveLeases: EffectArray.map(leaseExpiries, (expiresAt, index) => ({
      expiresAt,
      identity: Effect2.pipe(`${index}`, EffectString.repeat(64), EffectString.slice(0, 64)),
    })),
    operation: 'code-graph-snapshot-purge',
    snapshot: {
      baseSnapshotId: undefined,
      commit: Effect2.pipe('f', EffectString.repeat(40)),
      completedAt: new Date(1).toISOString(),
      dirty: false,
      edgeCount: 3,
      extractorSet: 'snapshot-purge-test',
      fileCount: 1,
      graphContentId: 'content-target',
      id: SNAPSHOT_ID,
      overlayFingerprint: undefined,
      repositoryId: REPOSITORY_ID,
      state: 'ready',
      symbolCount: 2,
      worktreeId: WORKTREE_ID,
    },
    vectorEvidenceDigest: Effect2.pipe('2', EffectString.repeat(64)),
    version: 1,
  };
}
