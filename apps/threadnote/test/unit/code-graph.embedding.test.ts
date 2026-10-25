import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as BunServices from '@effect/platform-bun/BunServices';
import {Database} from 'bun:sqlite';
import {renameSync, rmSync} from '@threadnote/testing/node-fs';
import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Path} from 'effect';
import {TestClock} from 'effect/testing';
import {describe, expect, it} from 'vitest';
import {
  CodeGraphEmbeddingIndex,
  executeCodeGraphVectorGeneration,
  selectGraphEmbeddingSymbols,
} from '@threadnote/graph/embedding';
import {CodeGraphStore} from '@threadnote/graph/store';
import {captureCodeGraphVectorPublication} from '@threadnote/graph/vector/publication';
import type {RepositoryIdentity} from '@threadnote/graph/types';
import {codeGraphLayout} from '@threadnote/graph/layout';
import {codeGraphVectorViewId} from '@threadnote/graph/vector/identity';
import {cleanupCodeGraphVectorPointers} from '@threadnote/graph/vector/maintenance';
import type {CodeGraphSnapshot, CodeGraphSymbol} from '@threadnote/graph/types';
import {
  makeCodeGraphVectorRetirementCapacityProtector,
  inspectCodeGraphVectorPageStorage,
  CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL,
  CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL,
  CODE_GRAPH_VECTOR_REUSE_INDEX_SQL,
  CODE_GRAPH_VECTORS_TABLE_SQL,
} from '@threadnote/graph/vector/retirement';
import {LocalModelRuntime, type LocalModelRuntimeShape} from '@threadnote/inference/engine/local-model-runtime';

import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore, type LocalModelStoreShape} from '@threadnote/inference/models/store';
import {mkdtemp, rm} from '../helpers/effect-filesystem.js';
const manifest = BUILTIN_MODEL_MANIFESTS.find(model => model.id === 'bge-small-en-v1.5-q8')!;
describe('native code graph vector generations', () => {
  effectIt.effect('isolates scoped vector build, status, search, force rebuild, and cleanup in one worktree', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-scoped-vectors-'});
      const catalog = yield* LocalModelCatalog;
      yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
      const vectors = yield* CodeGraphEmbeddingIndex;
      const scopeA = `code-graph-scope:${'a'.repeat(64)}`;
      const scopeB = `code-graph-scope:${'b'.repeat(64)}`;
      const full = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
      const a = {...full, scopeId: scopeA};
      const b = {...full, scopeId: scopeB};
      const source = [symbol('alpha', 'AlphaCoordinator', 'Coordinates alpha deployments.')];
      expect(yield* vectors.ensure(home, full, snapshot('full-snapshot'), source)).toMatchObject({
        embedded: 1,
        reused: 0,
      });
      expect(yield* vectors.ensure(home, a, {...snapshot('a-snapshot'), scopeId: scopeA}, source)).toMatchObject({
        embedded: 1,
        reused: 0,
      });
      expect(yield* vectors.ensure(home, b, {...snapshot('b-snapshot'), scopeId: scopeB}, source)).toMatchObject({
        embedded: 1,
        reused: 0,
      });
      expect(yield* vectors.check(home, full, 'full-snapshot')).toMatchObject({state: 'ready'});
      expect(yield* vectors.check(home, a, 'a-snapshot')).toMatchObject({state: 'ready'});
      expect(yield* vectors.check(home, b, 'b-snapshot')).toMatchObject({state: 'ready'});
      expect(yield* vectors.check(home, a, 'b-snapshot')).toMatchObject({state: 'stale'});
      expect((yield* vectors.search(home, a, 'b-snapshot', 'alpha deployment', 2)).size).toBe(0);
      const mismatch = yield* vectors
        .ensure(home, a, {...snapshot('wrong-snapshot'), scopeId: scopeB}, source)
        .pipe(Effect.flip);
      expect(String(mismatch)).toContain('scope does not match');
      yield* vectors.ensure(home, a, {...snapshot('a-snapshot'), scopeId: scopeA}, source, {force: true});
      const removed = yield* cleanupCodeGraphVectorPointers(
        home,
        full.checkoutId,
        full.worktreeId,
        'a-snapshot',
        scopeA,
      );
      expect(removed).toMatchObject({pointersRemoved: 1, warnings: []});
      expect(yield* vectors.check(home, a, 'a-snapshot')).toMatchObject({state: 'stale'});
      expect(yield* vectors.check(home, b, 'b-snapshot')).toMatchObject({state: 'ready'});
      expect(yield* vectors.check(home, full, 'full-snapshot')).toMatchObject({state: 'ready'});
      expect((yield* vectors.search(home, b, 'b-snapshot', 'alpha deployment', 2)).get('alpha')).toBeCloseTo(1);
      yield* Effect.sync(() => {
        const database = new Database(path.join(full.vectorRoot, manifest.id, 'vectors-v2.sqlite'));
        try {
          expect(database.query('SELECT worktree_id FROM vector_pointers ORDER BY worktree_id').all()).toEqual(
            [full.worktreeId, codeGraphVectorViewId(full.worktreeId, scopeB)]
              .sort()
              .map(worktree_id => ({worktree_id})),
          );
          expect(database.query('SELECT snapshot_id FROM vector_generation_retirements').all()).toEqual([
            {snapshot_id: 'a-snapshot'},
            {snapshot_id: 'a-snapshot'},
          ]);
        } finally {
          database.close();
        }
      });
    }).pipe(
      provideTestLayer(
        Layer.mergeAll(testEmbeddingLayer([]), LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS), TestSystemInfoLayer),
      ),
      provideTestLayer(BunServices.layer),
    ),
  );
  effectIt.effect(
    'keeps a completed generation pinned until attachment and adopts exact ready vectors without inference',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-attach-pin-'});
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
        const vectors = yield* CodeGraphEmbeddingIndex;
        const layout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
        const target = snapshot('pinned-ready');
        const atAttach = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const pending = yield* Effect.forkScoped(
          vectors.ensure(home, layout, target, [symbol('alpha-pin', 'Alpha', 'alpha')], {
            publication: {
              validate: Effect.void,
              attach: commit =>
                Deferred.succeed(atAttach, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(commit),
                ),
            },
          }),
        );
        yield* Deferred.await(atAttach);
        expect(yield* vectors.check(home, layout, target.id)).toMatchObject({state: 'stale'});
        yield* Effect.sync(() => {
          const db = new Database(path.join(layout.vectorRoot, manifest.id, 'vectors-v2.sqlite'));
          try {
            expect(db.query('SELECT state FROM vector_generations').all()).toEqual([{state: 'ready'}]);
            expect(db.query('SELECT COUNT(*) AS count FROM vector_generation_progress').get()).toEqual({count: 1});
            expect(db.query('SELECT COUNT(*) AS count FROM vector_pointers').get()).toEqual({count: 0});
            db.exec(
              'INSERT INTO vector_generation_retirements (generation, snapshot_id) SELECT generation, snapshot_id FROM vector_generations',
            );
            expect(db.query('SELECT generation FROM vector_generation_retirements').all()).toEqual([]);
          } finally {
            db.close();
          }
        });
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(pending)).toMatchObject({ready: true, embedded: 1});
        const sibling = {...layout, worktreeId: 'd'.repeat(64)};
        const adoptionReady = yield* Deferred.make<void>();
        const adopt = yield* Deferred.make<void>();
        const adoption = yield* Effect.forkScoped(
          vectors.ensure(
            home,
            sibling,
            {...target, worktreeId: sibling.worktreeId},
            [symbol('alpha-pin', 'Alpha', 'alpha')],
            {
              publication: {
                validate: Effect.void,
                attach: commit =>
                  Deferred.succeed(adoptionReady, undefined).pipe(
                    Effect.andThen(Deferred.await(adopt)),
                    Effect.andThen(commit),
                  ),
              },
            },
          ),
        );
        yield* Deferred.await(adoptionReady);
        yield* Effect.sync(() => {
          const db = new Database(path.join(layout.vectorRoot, manifest.id, 'vectors-v2.sqlite'));
          try {
            expect(db.query('SELECT COUNT(*) AS count FROM vector_generation_progress').get()).toEqual({count: 1});
            db.exec(
              'INSERT INTO vector_generation_retirements (generation, snapshot_id) SELECT generation, snapshot_id FROM vector_generations',
            );
            expect(db.query('SELECT generation FROM vector_generation_retirements').all()).toEqual([]);
          } finally {
            db.close();
          }
        });
        yield* Deferred.succeed(adopt, undefined);
        expect(yield* Fiber.join(adoption)).toMatchObject({ready: true, embedded: 0, reused: 1});
        expect((yield* vectors.search(home, sibling, target.id, 'alpha', 1)).get('alpha-pin')).toBeCloseTo(1);
      }).pipe(
        TestClock.withLive,
        provideTestLayer(
          Layer.mergeAll(testEmbeddingLayer([]), LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS), TestSystemInfoLayer),
        ),
        provideTestLayer(BunServices.layer),
      ),
  );
  effectIt.effect('rejects a future vector schema without replacing the physical database or its payload', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-future-'});
      const catalog = yield* LocalModelCatalog;
      yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
      const vectors = yield* CodeGraphEmbeddingIndex;
      const layout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
      const target = snapshot('future-schema');
      yield* vectors.ensure(home, layout, target, [symbol('alpha-future', 'Alpha', 'alpha')]);
      const databasePath = path.join(layout.vectorRoot, manifest.id, 'vectors-v2.sqlite');
      yield* Effect.sync(() => {
        const db = new Database(databasePath);
        try {
          db.exec('PRAGMA user_version = 999');
        } finally {
          db.close();
        }
      });
      const result = yield* vectors.ensure(home, layout, target, []).pipe(Effect.result);
      expect(result._tag).toBe('Failure');
      yield* Effect.sync(() => {
        const db = new Database(databasePath);
        try {
          expect(db.query('PRAGMA user_version').get()).toEqual({user_version: 999});
          expect(db.query('SELECT symbol_id FROM vectors').all()).toEqual([{symbol_id: 'alpha-future'}]);
        } finally {
          db.close();
        }
      });
    }).pipe(
      provideTestLayer(
        Layer.mergeAll(testEmbeddingLayer([]), LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS), TestSystemInfoLayer),
      ),
      provideTestLayer(BunServices.layer),
    ),
  );
  effectIt.effect('preserves the prior searchable generation when capacity denies a replacement', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-capacity-'});
      const catalog = yield* LocalModelCatalog;
      yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
      const vectors = yield* CodeGraphEmbeddingIndex;
      const layout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
      const source = [symbol('alpha-capacity', 'Alpha', 'alpha')];
      yield* vectors.ensure(home, layout, snapshot('before-pressure'), source);
      const databasePath = path.join(layout.vectorRoot, manifest.id, 'vectors-v2.sqlite');
      const protect = yield* makeCodeGraphVectorRetirementCapacityProtector({
        databasePath,
        threadnoteHome: home,
        availableDiskBytes: () => Effect.succeed(0),
      });
      const storage = yield* inspectCodeGraphVectorPageStorage(databasePath);
      let wrote = false;
      const denied = yield* protect(
        {operation: 'write code graph vector generation', rowCount: 400, finalFactBytes: 1_000_000},
        Effect.sync(() => {
          wrote = true;
        }),
        storage,
      ).pipe(Effect.result);
      expect(denied._tag).toBe('Failure');
      expect(wrote).toBe(false);
      expect(yield* vectors.check(home, layout, 'before-pressure')).toMatchObject({state: 'ready'});
      expect((yield* vectors.search(home, layout, 'before-pressure', 'alpha', 1)).get('alpha-capacity')).toBeCloseTo(1);
    }).pipe(
      provideTestLayer(
        Layer.mergeAll(testEmbeddingLayer([]), LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS), TestSystemInfoLayer),
      ),
      provideTestLayer(BunServices.layer),
    ),
  );
  effectIt.effect(
    'resumes bounded inference checkpoints with the same payload and semantic scores as a clean build',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-resume-'});
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
        const vectors = yield* CodeGraphEmbeddingIndex;
        const runtime = yield* LocalModelRuntime;
        const modelStore = yield* LocalModelStore;
        const layout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
        const clean = codeGraphLayout(path, home, 'c'.repeat(64), 'd'.repeat(64));
        const symbols = Array.from({length: 9}, (_, n) =>
          symbol(`resume-${n}`, n % 2 ? 'Beta' : 'Alpha', n % 2 ? 'beta' : 'alpha'),
        );
        const target = snapshot('resumed');
        const input = {
          catalog,
          force: false,
          fs,
          layout,
          modelStore,
          path,
          runtime,
          snapshot: target,
          symbols,
          threadnoteHome: home,
          maximumSteps: 1,
          maximumInferenceSymbolsPerStep: 2,
        };
        let progress = yield* executeCodeGraphVectorGeneration(input);
        expect(progress.ready).toBe(false);
        expect(yield* vectors.check(home, layout, target.id)).toMatchObject({state: 'stale'});
        let steps = 1;
        while (!progress.ready && steps < 10) {
          progress = yield* executeCodeGraphVectorGeneration({
            ...input,
            ownerToken: 'ownerToken' in progress ? progress.ownerToken : undefined,
          });
          steps += 1;
        }
        expect(progress.ready).toBe(true);
        expect(steps).toBeGreaterThan(1);
        yield* vectors.ensure(home, clean, {...target, worktreeId: clean.worktreeId}, symbols);
        expect(yield* vectors.search(home, layout, target.id, 'alpha', 9)).toEqual(
          yield* vectors.search(home, clean, target.id, 'alpha', 9),
        );
        yield* Effect.sync(() => {
          const payload = (root: string) => {
            const db = new Database(path.join(root, manifest.id, 'vectors-v2.sqlite'));
            try {
              return db
                .query('SELECT symbol_id, fingerprint, hex(vector) AS vector FROM vectors ORDER BY symbol_id')
                .all();
            } finally {
              db.close();
            }
          };
          expect(payload(layout.vectorRoot)).toEqual(payload(clean.vectorRoot));
        });
      }).pipe(
        provideTestLayer(
          Layer.mergeAll(testEmbeddingLayer([]), LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS), TestSystemInfoLayer),
        ),
        provideTestLayer(BunServices.layer),
      ),
  );
  effectIt.effect('attaches vectors through the real graph store without confusing graph and vector SQL sessions', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({prefix: 'threadnote-vector-real-publication-'});
      const catalog = yield* LocalModelCatalog;
      yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
      const layout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
      const target = {...snapshot(`cgsn_${'1'.repeat(40)}`), symbolCount: 1};
      const identity: RepositoryIdentity = {
        caseMode: 'sensitive',
        checkoutId: layout.checkoutId,
        displayName: 'publication',
        gitCommonDirectory: home,
        headCommit: target.commit,
        objectFormat: 'sha1',
        repoRoot: home,
        repositoryId: target.repositoryId,
        worktreeId: layout.worktreeId,
      };
      const store = yield* CodeGraphStore;
      yield* store.initialize(layout.databasePath);
      yield* store.markBuilding(layout.databasePath, identity, target);
      yield* Effect.sync(() => {
        const db = new Database(layout.databasePath);
        try {
          db.query("UPDATE snapshots SET state = 'ready' WHERE id = ?").run(target.id);
          db.query(
            "INSERT INTO snapshot_extractor_generations (snapshot_id, generation) SELECT ?, CAST(value AS INTEGER) FROM schema_metadata WHERE key = 'minimum_extractor_generation'",
          ).run(target.id);
        } finally {
          db.close();
        }
      });
      yield* store.promote(layout.databasePath, identity, target.id);
      const publication = yield* captureCodeGraphVectorPublication({
        store,
        layout,
        threadnoteHome: home,
        snapshot: target,
      });
      const vectors = yield* CodeGraphEmbeddingIndex;
      expect(
        yield* vectors.ensure(home, layout, target, [symbol('alpha-real', 'AlphaPublication', 'alpha')], {publication}),
      ).toMatchObject({ready: true, embedded: 1});
      expect(yield* vectors.check(home, layout, target.id)).toMatchObject({state: 'ready'});
      expect((yield* vectors.search(home, layout, target.id, 'alpha', 1)).get('alpha-real')).toBeCloseTo(1);
      expect((yield* store.readySnapshot(layout.databasePath, layout.worktreeId))?.id).toBe(target.id);
      yield* Effect.sync(() => {
        const db = new Database(layout.databasePath);
        try {
          expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('vectors', 'vector_pointers')").all()).toEqual(
            [],
          );
        } finally {
          db.close();
        }
      });
    }).pipe(
      provideTestLayer(
        Layer.mergeAll(
          testEmbeddingLayer([]),
          CodeGraphStore.layer.pipe(Layer.provide(TestSystemInfoLayer)),
          LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS),
        ),
      ),
      provideTestLayer(BunServices.layer),
      TestClock.withLive,
    ),
  );
  it('keeps every eligible symbol instead of truncating vectors at the former 20k cap', () => {
    const symbols = Array.from(
      {
        length: 20_001,
      },
      (_, index) => symbol(`symbol-${index}`, `Symbol${index}`, `Documents symbol ${index}.`),
    );
    expect(selectGraphEmbeddingSymbols(symbols)).toHaveLength(20_001);
  });
  effectIt.effect('reuses unchanged vectors, preserves sibling pointers, and serves semantic scores', () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() => mkdtemp('threadnote-code-graph-vectors-'));
      const embeddedBatches: number[] = [];
      const embeddingContextPools: Array<1 | 2 | 4 | 8 | undefined> = [];
      try {
        const result = yield* Effect.gen(function* () {
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          const vectors = yield* CodeGraphEmbeddingIndex;
          const layout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
          const otherWorktreeLayout = codeGraphLayout(path, home, 'a'.repeat(64), 'd'.repeat(64));
          const first = yield* vectors.ensure(home, layout, snapshot('snapshot-one'), [
            symbol('alpha', 'AlphaCoordinator', 'Coordinates alpha deployments.'),
            symbol('beta', 'BetaStore', 'Stores beta records.'),
          ]);
          const modelRoot = path.join(layout.vectorRoot, manifest.id);
          const unchanged = yield* vectors.ensure(home, layout, snapshot('snapshot-one'), []);
          const scores = yield* vectors.search(home, layout, 'snapshot-one', 'alpha deployment', 2);
          const shared = yield* vectors.ensure(home, otherWorktreeLayout, snapshot('snapshot-one'), [
            symbol('alpha', 'AlphaCoordinator', 'Coordinates alpha deployments.'),
            symbol('beta', 'BetaStore', 'Stores beta records.'),
          ]);
          const changed = yield* vectors.ensure(home, layout, snapshot('snapshot-two'), [
            symbol('alpha', 'AlphaCoordinator', 'Coordinates alpha deployments.'),
            symbol('beta', 'BetaStore', 'Stores changed beta records.'),
          ]);
          const duplicate = symbol('gamma', 'GammaService', 'Serves gamma records.');
          const deduplicated = yield* vectors.ensure(home, layout, snapshot('snapshot-three'), [duplicate, duplicate]);
          const forced = yield* vectors.ensure(home, layout, snapshot('snapshot-three'), [duplicate, duplicate], {
            force: true,
          });
          const checked = yield* vectors.check(home, layout, 'snapshot-three');
          const preservedScores = yield* vectors.search(
            home,
            otherWorktreeLayout,
            'snapshot-one',
            'alpha deployment',
            2,
          );
          yield* vectors.ensure(home, layout, snapshot('snapshot-three'), [duplicate]);
          const preservedUnavailablePointer = yield* vectors.check(home, otherWorktreeLayout, 'snapshot-one');
          return {
            changed,
            checked,
            databaseReady: yield* fs.exists(path.join(modelRoot, 'vectors-v2.sqlite')),
            deduplicated,
            first,
            forced,
            preservedScores,
            preservedUnavailablePointer,
            scores,
            shared,
            unchanged,
          };
        }).pipe(
          provideTestLayer(
            Layer.merge(
              testEmbeddingLayer(embeddedBatches, undefined, embeddingContextPools),
              LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS),
            ),
          ),
          provideTestLayer(BunServices.layer),
        );
        expect(result.first).toMatchObject({
          embedded: 2,
          ready: true,
          reused: 0,
        });
        expect(result.unchanged).toMatchObject({
          embedded: 0,
          ready: true,
          reused: 2,
        });
        expect(result.changed).toMatchObject({
          embedded: 1,
          ready: true,
          reused: 1,
        });
        expect(result.shared).toMatchObject({
          embedded: 0,
          ready: true,
          reused: 2,
        });
        expect(result.deduplicated).toMatchObject({
          embedded: 1,
          ready: true,
          reused: 0,
        });
        expect(result.forced).toMatchObject({
          embedded: 1,
          ready: true,
          reused: 0,
        });
        expect(result.checked).toEqual({
          modelId: manifest.id,
          reused: 1,
          state: 'ready',
        });
        expect(result.databaseReady).toBe(true);
        expect(result.scores.get('alpha')).toBeCloseTo(1);
        expect(result.preservedScores.get('alpha')).toBeCloseTo(1);
        expect(result.preservedUnavailablePointer).toMatchObject({
          state: 'ready',
        });
        expect(result.scores.has('beta')).toBe(false);
        expect(embeddedBatches).toEqual([2, 1, 1, 1, 1, 1]);
        expect(embeddingContextPools).toEqual([8, undefined, 8, 8, 8, undefined]);
      } finally {
        yield* Effect.promise(() =>
          rm(home, {
            force: true,
            recursive: true,
          }),
        );
      }
    }),
  );
  effectIt.effect('prepares the released pointer index without pruning or admitting under the embedding lock', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({
          prefix: 'threadnote-code-graph-vector-pointer-index-',
        });
        const pointerCount = 4_096;
        const orphanCount = 512;
        const result = yield* Effect.gen(function* () {
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          const vectors = yield* CodeGraphEmbeddingIndex;
          const layout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
          const target = snapshot('snapshot-pointer-load');
          yield* vectors.ensure(home, layout, target, [
            symbol('pointer-load', 'PointerLoad', 'Exercises pointer pruning.'),
          ]);
          const databasePath = path.join(layout.vectorRoot, manifest.id, 'vectors-v2.sqlite');
          yield* Effect.sync(() => rebuildReleasedVectorPointerLoad(databasePath, pointerCount, orphanCount));
          const refreshed = yield* vectors.ensure(home, layout, target, []);
          return {
            databasePath,
            refreshed,
          };
        }).pipe(
          provideTestLayer(Layer.merge(testEmbeddingLayer([]), LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS))),
          provideTestLayer(BunServices.layer),
        );
        yield* Effect.sync(() => {
          const database = new Database(result.databasePath, {
            readonly: true,
            strict: true,
          });
          try {
            const indexes = database.query("PRAGMA index_list('vector_pointers')").all() as readonly {
              readonly name: string;
            }[];
            const plan = database
              .query(
                `EXPLAIN QUERY PLAN
             SELECT generation
             FROM vector_generations
             WHERE generation > ?
             ORDER BY vector_generations.generation
             LIMIT 1`,
              )
              .all('') as readonly {
              readonly detail: string;
            }[];
            const details = plan.map(row => row.detail);
            expect(database.query('PRAGMA user_version').get()).toEqual({user_version: 3});
            expect(result.databasePath.endsWith('/vectors-v2.sqlite')).toBe(true);
            expect(result.refreshed).toMatchObject({
              embedded: 0,
              ready: true,
              reused: 1,
            });
            expect(indexes.map(index => index.name)).toContain('vector_pointer_generation_lookup');
            expect(details).toContainEqual(expect.stringContaining('SEARCH vector_generations USING'));
            expect(details.some(detail => detail.includes('SCAN '))).toBe(false);
            expect(details.some(detail => detail.includes('USE TEMP B-TREE'))).toBe(false);
            expect(database.query('SELECT COUNT(*) AS count FROM vector_pointers').get()).toEqual({
              count: pointerCount + 1,
            });
            expect(database.query('SELECT COUNT(*) AS count FROM vector_generations').get()).toEqual({
              count: pointerCount + orphanCount + 1,
            });
            expect(
              database.query("SELECT COUNT(*) AS count FROM vector_generations WHERE generation LIKE 'orphan-%'").get(),
            ).toEqual({
              count: orphanCount,
            });
            expect(database.query('SELECT COUNT(*) AS count FROM vector_generation_retirements').get()).toEqual({
              count: 0,
            });
          } finally {
            database.close(false);
          }
        });
      }).pipe(
        provideTestLayer(Layer.merge(testEmbeddingLayer([]), LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS))),
        provideTestLayer(BunServices.layer),
      ),
    ),
  );
  effectIt.effect(
    'builds and searches a paged SQLite vector generation without materializing a repository symbol array',
    () =>
      Effect.gen(function* () {
        const home = yield* Effect.promise(() => mkdtemp('threadnote-code-graph-vector-pages-'));
        const embeddedBatches: number[] = [];
        const pageLimits: number[] = [];
        try {
          const symbols = Array.from(
            {
              length: 901,
            },
            (_, index) =>
              symbol(`paged-${index.toString().padStart(4, '0')}`, `Paged${index}`, `Paged symbol ${index}.`),
          );
          const result = yield* Effect.gen(function* () {
            const path = yield* Path.Path;
            const catalog = yield* LocalModelCatalog;
            yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
            const vectors = yield* CodeGraphEmbeddingIndex;
            const layout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
            const source = {
              count: Effect.succeed(symbols.length),
              loadPage: (
                cursor:
                  | {
                      readonly id: string;
                    }
                  | undefined,
                limit: number,
              ) => {
                pageLimits.push(limit);
                const start = cursor ? symbols.findIndex(candidate => candidate.id === cursor.id) + 1 : 0;
                return Effect.succeed(symbols.slice(start, start + limit));
              },
            };
            const built = yield* vectors.ensure(
              home,
              layout,
              {
                ...snapshot('snapshot-paged'),
                symbolCount: symbols.length,
              },
              source,
            );
            const scores = yield* vectors.search(home, layout, 'snapshot-paged', 'paged symbol', 5);
            return {
              built,
              scores,
            };
          }).pipe(
            provideTestLayer(
              Layer.merge(testEmbeddingLayer(embeddedBatches), LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS)),
            ),
            provideTestLayer(BunServices.layer),
          );
          expect(result.built).toMatchObject({
            embedded: 901,
            ready: true,
            reused: 0,
          });
          expect(result.scores.size).toBe(5);
          expect(pageLimits).toEqual([400, 400, 400]);
          expect(Math.max(...embeddedBatches)).toBeLessThanOrEqual(128);
        } finally {
          yield* Effect.promise(() =>
            rm(home, {
              force: true,
              recursive: true,
            }),
          );
        }
      }),
  );
  effectIt.effect('serializes linked-worktree vector writers without deleting a live generation', () =>
    TestClock.withLive(
      Effect.gen(function* () {
        const home = yield* Effect.promise(() => mkdtemp('threadnote-code-graph-vector-concurrency-'));
        let activeEmbeddings = 0;
        let embedCalls = 0;
        let maximumActiveEmbeddings = 0;
        let releaseFirst!: () => void;
        let reportFirstStarted!: () => void;
        const firstRelease = new Promise<void>(resolve => (releaseFirst = resolve));
        const firstStarted = new Promise<void>(resolve => (reportFirstStarted = resolve));
        const runtime = LocalModelRuntime.of({
          diagnostics: Effect.succeed({
            backend: 'fake',
            buildType: 'prebuilt',
            cpuMathCores: 4,
          }),
          embedMany: ({inputs, manifest: requested}) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                activeEmbeddings += 1;
                maximumActiveEmbeddings = Math.max(maximumActiveEmbeddings, activeEmbeddings);
                embedCalls += 1;
                if (embedCalls === 1) reportFirstStarted();
                return embedCalls;
              }),
              call =>
                (call === 1 ? Effect.promise(() => firstRelease) : Effect.void).pipe(
                  Effect.as(
                    inputs.map(input => unitVector(requested.dimensions ?? 0, input.includes('alpha') ? 0 : 1)),
                  ),
                ),
              () =>
                Effect.sync(() => {
                  activeEmbeddings -= 1;
                }),
            ),
          generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
          rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
        });
        try {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const path = yield* Path.Path;
              const catalog = yield* LocalModelCatalog;
              yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
              const vectors = yield* CodeGraphEmbeddingIndex;
              const firstLayout = codeGraphLayout(path, home, 'a'.repeat(64), 'b'.repeat(64));
              const secondLayout = codeGraphLayout(path, home, 'a'.repeat(64), 'd'.repeat(64));
              const first = yield* Effect.forkScoped(
                vectors.ensure(home, firstLayout, snapshot('snapshot-concurrent-one'), [
                  symbol('alpha-concurrent', 'AlphaConcurrent', 'alpha concurrent symbol'),
                ]),
              );
              yield* Effect.promise(() => firstStarted);
              const second = yield* Effect.forkScoped(
                vectors.ensure(home, secondLayout, snapshot('snapshot-concurrent-two'), [
                  symbol('beta-concurrent', 'BetaConcurrent', 'beta concurrent symbol'),
                ]),
              );
              yield* Effect.sleep(100);
              const callsWhileFirstWasBlocked = embedCalls;
              yield* Effect.sync(releaseFirst);
              const summaries = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
              return {
                callsWhileFirstWasBlocked,
                summaries,
              };
            }),
          ).pipe(
            provideTestLayer(
              Layer.merge(testEmbeddingLayer([], runtime), LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS)),
            ),
            provideTestLayer(BunServices.layer),
          );
          expect(result.callsWhileFirstWasBlocked).toBe(1);
          expect(maximumActiveEmbeddings).toBe(1);
          expect(result.summaries).toEqual([
            expect.objectContaining({
              embedded: 1,
              ready: true,
            }),
            expect.objectContaining({
              embedded: 1,
              ready: true,
            }),
          ]);
        } finally {
          releaseFirst?.();
          yield* Effect.promise(() =>
            rm(home, {
              force: true,
              recursive: true,
            }),
          );
        }
      }),
    ),
  );
});
function testEmbeddingLayer(
  embeddedBatches: number[],
  runtimeOverride?: LocalModelRuntimeShape,
  embeddingContextPools?: Array<1 | 2 | 4 | 8 | undefined>,
) {
  const modelStoreLayer = Layer.succeed(
    LocalModelStore,
    LocalModelStore.of({
      install: () => Effect.die(TestError.make({message: 'Unexpected install'})),
      path: root => `${root}/models/fake.gguf`,
      remove: () => Effect.succeed(false),
      status: root => Effect.succeed(installation(root)),
      verify: root => Effect.succeed(installation(root)),
    } satisfies LocalModelStoreShape),
  );
  const runtimeLayer = Layer.succeed(
    LocalModelRuntime,
    runtimeOverride ??
      LocalModelRuntime.of({
        diagnostics: Effect.succeed({
          backend: 'fake',
          buildType: 'prebuilt',
          cpuMathCores: 4,
        }),
        embedMany: ({embeddingContextPoolSize, inputs, manifest: requested}) => {
          embeddedBatches.push(inputs.length);
          embeddingContextPools?.push(embeddingContextPoolSize);
          return Effect.succeed(
            inputs.map(input => unitVector(requested.dimensions ?? 0, input.toLowerCase().includes('alpha') ? 0 : 1)),
          );
        },
        generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
        rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
      }),
  );
  return CodeGraphEmbeddingIndex.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        LocalModelCatalog.layer(BUILTIN_MODEL_MANIFESTS),
        modelStoreLayer,
        runtimeLayer,
        TestSystemInfoLayer,
      ),
    ),
  );
}
function rebuildReleasedVectorPointerLoad(databasePath: string, pointerCount: number, orphanCount: number): void {
  const replacementPath = `${databasePath}.released-v2`;
  rmSync(replacementPath, {
    force: true,
  });
  const source = new Database(databasePath, {
    create: false,
    strict: true,
  });
  try {
    source.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    source.close(false);
  }
  const database = new Database(replacementPath, {
    create: true,
    strict: true,
  });
  let sourceAttached = false;
  try {
    database.exec(CODE_GRAPH_VECTOR_GENERATIONS_TABLE_SQL);
    database.exec(CODE_GRAPH_VECTOR_POINTERS_TABLE_SQL);
    database.exec(CODE_GRAPH_VECTORS_TABLE_SQL);
    database.exec(CODE_GRAPH_VECTOR_REUSE_INDEX_SQL);
    database.exec('PRAGMA user_version = 2');
    database.query('ATTACH DATABASE ? AS source').run(databasePath);
    sourceAttached = true;
    const template = database
      .query<
        {
          readonly created_at: string;
          readonly dimensions: number;
          readonly model_id: string;
          readonly model_sha256: string;
          readonly template_version: number;
        },
        []
      >(
        `SELECT created_at, dimensions, model_id, model_sha256, template_version
         FROM source.vector_generations
         LIMIT 1`,
      )
      .get();
    if (!template) throw TestError.make({message: 'Vector pointer load fixture has no generation template.'});
    const insertGeneration = database.prepare(`INSERT INTO vector_generations (
         generation, snapshot_id, model_id, model_sha256, dimensions,
         template_version, count, state, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, 'ready', ?)`);
    const insertPointer = database.prepare('INSERT INTO vector_pointers (worktree_id, generation) VALUES (?, ?)');
    database.transaction(() => {
      database.exec(`INSERT INTO vector_generations (
           generation, snapshot_id, model_id, model_sha256, dimensions,
           template_version, count, state, created_at
         )
         SELECT generation, snapshot_id, model_id, model_sha256, dimensions,
                template_version, count, state, created_at
         FROM source.vector_generations`);
      database.exec(`INSERT INTO vector_pointers (worktree_id, generation)
         SELECT worktree_id, generation FROM source.vector_pointers`);
      database.exec(`INSERT INTO vectors (generation, symbol_id, fingerprint, vector)
         SELECT generation, symbol_id, fingerprint, vector FROM source.vectors`);
      for (let index = 0; index < pointerCount; index += 1) {
        const generation = `referenced-${index.toString().padStart(4, '0')}`;
        insertGeneration.run(
          generation,
          `snapshot-${index}`,
          template.model_id,
          template.model_sha256,
          template.dimensions,
          template.template_version,
          template.created_at,
        );
        insertPointer.run(index.toString(16).padStart(64, '0'), generation);
      }
      for (let index = 0; index < orphanCount; index += 1) {
        insertGeneration.run(
          `orphan-${index.toString().padStart(4, '0')}`,
          `orphan-snapshot-${index}`,
          template.model_id,
          template.model_sha256,
          template.dimensions,
          template.template_version,
          template.created_at,
        );
      }
    })();
    database.exec('DETACH DATABASE source');
    sourceAttached = false;
    const objects = database
      .query<
        {
          readonly name: string;
        },
        []
      >(
        `SELECT name
         FROM sqlite_master
         WHERE name IN ('vector_generation_retirements', 'vector_retirement_state')
            OR type = 'trigger'
            OR name = 'vector_pointer_generation_lookup'
            OR name = 'sqlite_sequence'
         ORDER BY name`,
      )
      .all();
    if (objects.length !== 0) {
      throw TestError.make({message: 'Released vector v2 fixture unexpectedly contains retirement authority.'});
    }
  } finally {
    if (sourceAttached) database.exec('DETACH DATABASE source');
    database.close(false);
  }
  rmSync(databasePath, {
    force: true,
  });
  rmSync(`${databasePath}-shm`, {
    force: true,
  });
  rmSync(`${databasePath}-wal`, {
    force: true,
  });
  renameSync(replacementPath, databasePath);
}
function symbol(id: string, name: string, documentation: string): CodeGraphSymbol {
  return {
    contentHash: id.repeat(64).slice(0, 64),
    documentation,
    exported: true,
    id,
    kind: 'class',
    language: 'typescript',
    name,
    path: `src/${id}.ts`,
    qualifiedName: name,
    span: {
      column: 1,
      endColumn: 2,
      endLine: 1,
      line: 1,
    },
  };
}
function snapshot(id: string): CodeGraphSnapshot {
  return {
    commit: 'c'.repeat(40),
    dirty: false,
    edgeCount: 0,
    extractorSet: 'test',
    fileCount: 2,
    id,
    repositoryId: 'a'.repeat(64),
    state: 'ready',
    symbolCount: 2,
    worktreeId: 'b'.repeat(64),
  };
}
function installation(home: string) {
  return {
    bytes: manifest.size,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: `${home}/models/fake.gguf`,
    verified: true,
  };
}
function unitVector(dimensions: number, axis: number): readonly number[] {
  return Array.from(
    {
      length: dimensions,
    },
    (_, index) => (index === axis ? 1 : 0),
  );
}
