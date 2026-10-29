import {Array as EffectArray} from 'effect';
import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import {TestError} from '@threadnote/testing/test-error';
import {Database} from 'bun:sqlite';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it as effectIt} from '@effect/vitest';
import {Clock, Effect, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import * as FC from 'fast-check';
import {cleanupCodeGraphVectorPointers, prepareCodeGraphVectorRetirement} from '@threadnote/graph/vector/maintenance';
import {makeCachedProcessStartIdentityResolver, SystemInfo} from '@threadnote/platform/system';
import {codeGraphVectorViewId} from '@threadnote/graph/vector/identity';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const CHECKOUT_ID = Effect2.pipe('a', EffectString.repeat(64));
const WORKTREE_ID = Effect2.pipe('1', EffectString.repeat(64));
const SHARED_WORKTREE_ID = Effect2.pipe('2', EffectString.repeat(64));
const EXPECTED_SNAPSHOT_ID = 'snapshot-expected';
const VectorMaintenanceTestLayer = Layer.mergeAll(BunServices.layer, TestSystemInfoLayer);

describe('code graph vector pointer maintenance', () => {
  effectIt.layer(VectorMaintenanceTestLayer)(layerIt => {
    fcEffectProp(
      layerIt,
      'removes only the selected scope pointer, preserving full and sibling views',
      {scopes: FC.uniqueArray(FC.integer({min: 0, max: 1000}), {minLength: 2, maxLength: 5})},
      ({scopes}) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-scope-cleanup-'});
          const scopeIds = EffectArray.map(
            scopes,
            value => `code-graph-scope:${Effect2.pipe(value.toString(16), EffectString.padStart(64, '0'))}`,
          );
          const views = [
            WORKTREE_ID,
            ...EffectArray.map(scopeIds, scopeId => codeGraphVectorViewId(WORKTREE_ID, scopeId)),
          ];
          const databasePath = yield* seedVectorDatabase(
            home,
            'scoped-model',
            [{generation: 'shared-snapshot-generation', snapshotId: EXPECTED_SNAPSHOT_ID}],
            EffectArray.map(views, worktreeId => ({generation: 'shared-snapshot-generation', worktreeId})),
          );
          const first = yield* cleanupCodeGraphVectorPointers(
            home,
            CHECKOUT_ID,
            WORKTREE_ID,
            EXPECTED_SNAPSHOT_ID,
            scopeIds[0],
          );
          const second = yield* cleanupCodeGraphVectorPointers(
            home,
            CHECKOUT_ID,
            WORKTREE_ID,
            EXPECTED_SNAPSHOT_ID,
            scopeIds[0],
          );
          expect(first.pointersRemoved).toBe(1);
          expect(first.warnings).toEqual([]);
          expect(second.pointersRemoved).toBe(0);
          expect(EffectArray.map(readPointers(databasePath), row => row.worktree_id).sort()).toEqual(
            EffectArray.filter(views, view => view !== views[1]).sort(),
          );
          expect(readGenerations(databasePath)).toEqual(['shared-snapshot-generation']);
        }),
      {fastCheck: {numRuns: 8}},
    );
    layerIt.effect('removes only the expected pointer and preserves shared generations and newer promotions', () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-maintenance-'});
          const expectedDatabase = yield* seedVectorDatabase(
            home,
            'model-expected',
            [{generation: 'generation-expected', snapshotId: EXPECTED_SNAPSHOT_ID}],
            [
              {generation: 'generation-expected', worktreeId: WORKTREE_ID},
              {generation: 'generation-expected', worktreeId: SHARED_WORKTREE_ID},
            ],
          );
          const promotedDatabase = yield* seedVectorDatabase(
            home,
            'model-promoted',
            [{generation: 'generation-new', snapshotId: 'snapshot-new'}],
            [{generation: 'generation-new', worktreeId: WORKTREE_ID}],
          );

          const first = yield* cleanupCodeGraphVectorPointers(home, CHECKOUT_ID, WORKTREE_ID, EXPECTED_SNAPSHOT_ID);
          const second = yield* cleanupCodeGraphVectorPointers(home, CHECKOUT_ID, WORKTREE_ID, EXPECTED_SNAPSHOT_ID);

          expect(first).toEqual({
            databasesInspected: 2,
            databasesProcessed: 2,
            pointersRemoved: 1,
            warnings: [],
          });
          expect(second.pointersRemoved).toBe(0);
          expect(readPointers(expectedDatabase)).toEqual([
            {generation: 'generation-expected', worktree_id: SHARED_WORKTREE_ID},
          ]);
          expect(readGenerations(expectedDatabase)).toEqual(['generation-expected']);
          expect(readPointers(promotedDatabase)).toEqual([{generation: 'generation-new', worktree_id: WORKTREE_ID}]);
          expect(path.basename(expectedDatabase)).toBe('vectors-v2.sqlite');
        }),
      ),
    );

    fcEffectProp(
      layerIt,
      'matches the worktree plus expected-snapshot join model and is idempotent across model order',
      {
        matches: FC.array(FC.boolean(), {maxLength: 8, minLength: 1}),
        reverse: FC.boolean(),
      },
      ({matches, reverse}) =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-maintenance-property-'});
            const fixtures = EffectArray.map(matches, (matchesExpected, index) => ({index, matchesExpected}));
            if (reverse) fixtures.reverse();
            const databases = yield* Effect.forEach(
              fixtures,
              fixture =>
                seedVectorDatabase(
                  home,
                  `model-${Effect2.pipe(String(fixture.index), EffectString.padStart(2, '0'))}`,
                  [
                    {
                      generation: `generation-${fixture.index}`,
                      snapshotId: fixture.matchesExpected ? EXPECTED_SNAPSHOT_ID : `snapshot-other-${fixture.index}`,
                    },
                  ],
                  [{generation: `generation-${fixture.index}`, worktreeId: WORKTREE_ID}],
                ),
              {concurrency: 1},
            );

            const first = yield* cleanupCodeGraphVectorPointers(home, CHECKOUT_ID, WORKTREE_ID, EXPECTED_SNAPSHOT_ID);
            const second = yield* cleanupCodeGraphVectorPointers(home, CHECKOUT_ID, WORKTREE_ID, EXPECTED_SNAPSHOT_ID);

            expect(first.pointersRemoved).toBe(EffectArray.filter(matches, Boolean).length);
            expect(first.warnings).toEqual([]);
            expect(second.pointersRemoved).toBe(0);
            for (const [position, fixture] of fixtures.entries()) {
              expect(readPointers(databases[position]).length).toBe(fixture.matchesExpected ? 0 : 1);
              expect(readGenerations(databases[position])).toEqual([`generation-${fixture.index}`]);
            }
          }),
        ),
      {fastCheck: {numRuns: 30}},
    );

    layerIt.effect('preserves an external database behind a derived-store symlink', () =>
      Effect.scoped(
        Effect.gen(function* () {
          if (process.platform === 'win32') return;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-maintenance-symlink-'});
          const externalDatabase = path.join(home, 'source-sentinel.sqlite');
          yield* Effect.sync(() =>
            createVectorDatabase(
              externalDatabase,
              'external-model',
              [{generation: 'generation-external', snapshotId: EXPECTED_SNAPSHOT_ID}],
              [{generation: 'generation-external', worktreeId: WORKTREE_ID}],
            ),
          );
          const modelRoot = path.join(
            home,
            'indexes',
            'code-graph',
            'repositories',
            CHECKOUT_ID,
            'vectors',
            'model-symlink',
          );
          yield* fs.makeDirectory(modelRoot, {recursive: true, mode: 0o700});
          yield* fs.symlink(externalDatabase, path.join(modelRoot, 'vectors-v2.sqlite'));

          const result = yield* cleanupCodeGraphVectorPointers(home, CHECKOUT_ID, WORKTREE_ID, EXPECTED_SNAPSHOT_ID);

          expect(result.pointersRemoved).toBe(0);
          expect(result.warnings).toEqual([
            {
              code: 'vector-inventory-unsafe',
              message: 'Vector cleanup preserved one or more unsafe derived-store entries for manual inspection.',
              occurrences: 1,
              retryable: false,
            },
          ]);
          expect(readPointers(externalDatabase)).toEqual([
            {generation: 'generation-external', worktree_id: WORKTREE_ID},
          ]);
        }),
      ),
    );

    layerIt.effect('rejects a symlinked checkout ancestor without opening the external vector database', () =>
      Effect.scoped(
        Effect.gen(function* () {
          if (process.platform === 'win32') return;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-maintenance-ancestor-'});
          const externalCheckout = path.join(home, 'external-checkout');
          const externalDatabase = path.join(externalCheckout, 'vectors', 'model-external', 'vectors-v2.sqlite');
          yield* fs.makeDirectory(path.dirname(externalDatabase), {recursive: true, mode: 0o700});
          yield* Effect.sync(() =>
            createVectorDatabase(
              externalDatabase,
              'model-external',
              [{generation: 'generation-external', snapshotId: EXPECTED_SNAPSHOT_ID}],
              [{generation: 'generation-external', worktreeId: WORKTREE_ID}],
            ),
          );
          const repositories = path.join(home, 'indexes', 'code-graph', 'repositories');
          yield* fs.makeDirectory(repositories, {recursive: true, mode: 0o700});
          yield* fs.symlink(externalCheckout, path.join(repositories, CHECKOUT_ID));

          const result = yield* cleanupCodeGraphVectorPointers(home, CHECKOUT_ID, WORKTREE_ID, EXPECTED_SNAPSHOT_ID);

          expect(result).toEqual({
            databasesInspected: 0,
            databasesProcessed: 0,
            pointersRemoved: 0,
            warnings: [
              {
                code: 'vector-inventory-unavailable',
                message: 'Vector cleanup could not inspect the derived-store inventory; rerun the command.',
                occurrences: 1,
                retryable: true,
              },
            ],
          });
          expect(readPointers(externalDatabase)).toEqual([
            {generation: 'generation-external', worktree_id: WORKTREE_ID},
          ]);
        }),
      ),
    );

    layerIt.effect(
      'keeps thirty-two zero-wait vector stores below the wall-clock bound after an unavailable probe',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const system = yield* SystemInfo;
            const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-maintenance-load-'});
            yield* Effect.forEach(
              Array.from({length: 32}, (_, index) => index),
              index =>
                seedVectorDatabase(
                  home,
                  `model-load-${Effect2.pipe(String(index), EffectString.padStart(2, '0'))}`,
                  [{generation: `generation-load-${index}`, snapshotId: EXPECTED_SNAPSHOT_ID}],
                  [{generation: `generation-load-${index}`, worktreeId: WORKTREE_ID}],
                ),
              {concurrency: 1},
            );
            let processIdentityProbes = 0;
            const processStartIdentity = yield* makeCachedProcessStartIdentityResolver(system.processId, processId =>
              processId === system.processId
                ? Effect.sync(() => {
                    processIdentityProbes += 1;
                    return undefined;
                  })
                : system.processStartIdentity(processId),
            );
            expect(yield* processStartIdentity(system.processId)).toBeUndefined();
            const unavailableIdentitySystem = SystemInfo.of({...system, processStartIdentity});

            const startedAt = yield* TestClock.withLive(Clock.currentTimeMillis);
            const result = yield* cleanupCodeGraphVectorPointers(
              home,
              CHECKOUT_ID,
              WORKTREE_ID,
              EXPECTED_SNAPSHOT_ID,
            ).pipe(Effect.provideService(SystemInfo, unavailableIdentitySystem));
            const elapsed = (yield* TestClock.withLive(Clock.currentTimeMillis)) - startedAt;

            expect(result).toEqual({
              databasesInspected: 32,
              databasesProcessed: 32,
              pointersRemoved: 32,
              warnings: [],
            });
            expect(processIdentityProbes).toBe(1);
            expect(elapsed).toBeLessThan(5_000);
          }),
        ),
    );
  });
});

interface GenerationSeed {
  readonly generation: string;
  readonly snapshotId: string;
}

interface PointerSeed {
  readonly generation: string;
  readonly worktreeId: string;
}

function seedVectorDatabase(
  home: string,
  modelId: string,
  generations: readonly GenerationSeed[],
  pointers: readonly PointerSeed[],
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const modelRoot = path.join(home, 'indexes', 'code-graph', 'repositories', CHECKOUT_ID, 'vectors', modelId);
    yield* fs.makeDirectory(modelRoot, {recursive: true, mode: 0o700});
    const databasePath = path.join(modelRoot, 'vectors-v2.sqlite');
    yield* Effect.sync(() => createVectorDatabase(databasePath, modelId, generations, pointers));
    for (let step = 0; step < 4; step += 1) {
      const result = yield* prepareCodeGraphVectorRetirement(databasePath, {
        capacityProtector: (_boundary, transaction) => transaction,
      });
      if (result.state === 'ready') return databasePath;
    }
    return yield* Effect.die(TestError.make({message: 'Vector retirement schema did not become ready.'}));
  });
}

function createVectorDatabase(
  databasePath: string,
  modelId: string,
  generations: readonly GenerationSeed[],
  pointers: readonly PointerSeed[],
): void {
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
    for (const generation of generations) {
      database
        .query(
          `INSERT INTO vector_generations
           (generation, snapshot_id, model_id, model_sha256, dimensions, template_version, count, state, created_at)
           VALUES (?, ?, ?, ?, 3, 1, 0, 'ready', ?)`,
        )
        .run(
          generation.generation,
          generation.snapshotId,
          modelId,
          Effect2.pipe('f', EffectString.repeat(64)),
          new Date(0).toISOString(),
        );
    }
    for (const pointer of pointers) {
      database
        .query('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)')
        .run(pointer.worktreeId, pointer.generation);
    }
  } finally {
    database.close(false);
  }
}

function readPointers(databasePath: string): readonly {readonly generation: string; readonly worktree_id: string}[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return database
      .query<{readonly generation: string; readonly worktree_id: string}, []>(
        'SELECT worktree_id, generation FROM vector_pointers ORDER BY worktree_id',
      )
      .all();
  } finally {
    database.close(false);
  }
}

function readGenerations(databasePath: string): readonly string[] {
  const database = new Database(databasePath, {readonly: true, strict: true});
  try {
    return EffectArray.map(
      database
        .query<{readonly generation: string}, []>('SELECT generation FROM vector_generations ORDER BY generation')
        .all(),
      row => row.generation,
    );
  } finally {
    database.close(false);
  }
}
