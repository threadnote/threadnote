import * as ExternalResources from '@threadnote/store/external-resource';
import {loadRecallVectorAuthorizationKey} from '../src/vector/preparation-identity.js';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import fc from 'fast-check';
import {
  releasePreparedRecallDocument,
  releaseResolvedRecallMetadata,
  recallVectorTarget,
  prepareRecallVectorMetadata,
} from '../src/background/vector-preparation.js';
import {openRecallVectorPreparationSource} from '../src/index/vector-preparation-source.js';
import {recallEmbeddingDemandKey} from '../src/background/demand.js';
import {RECALL_CHUNKER_VERSION} from '../src/chunker.js';
import * as EffectString from 'effect/String';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Array as EffectArray, Clock, Effect, FileSystem, Layer, Option, Path} from 'effect';
import {describe, expect, vi} from 'vitest';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {SystemInfo} from '@threadnote/platform/system';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelStore} from '@threadnote/inference/models/store';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {loadRecallIndexData, expireRecallIndexValidation} from '../src/index.js';
import {
  vectorIndexGenerationReadiness,
  vectorIndexStatus,
  ensureVectorIndex,
  vectorIndexDatabaseFilename,
  selectedSemanticScores,
  recallVectorStorage,
} from '../src/vector-index.js';
import {runRecallVectorPreparationBatch, stepRecallVectorPreparation} from '../src/background/vector-step.js';

const manifest = {
  ...Option.getOrThrow(EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.role === 'embedding')),
  dimensions: 2,
  promptPrefixes: {document: 'document: ', query: 'query: '},
};
const platform = Layer.mergeAll(
  Layer.merge(BunServices.layer, cryptoLayer),
  SystemInfo.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeEntrypoint, {developmentEntrypoint: import.meta.path}),
        Layer.succeed(ChildEnvironmentPolicy, {
          preserveIntendedChild: environment => environment,
          sanitizeExternal: environment => environment,
        }),
      ),
    ),
  ),
  LocalModelCatalog.layer([manifest]),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'recall-vector-step-'});
  const config = {account: 'local', agentContextHome: home, user: 'test'};
  const resource = path.join(home, 'data/local/resources/repos/threadnote/document.md');
  yield* fs.makeDirectory(path.dirname(resource), {recursive: true});
  yield* fs.writeFileString(
    resource,
    '# Document\n\n' + EffectString.repeat(400)('Bounded resumable example content. '),
  );
  const index = yield* loadRecallIndexData(config, {includeInactive: false});
  yield* selectLocalModel(home, yield* LocalModelCatalog, 'embedding', manifest.id);
  const filename = path.join(home, 'indexes/vectors', manifest.id, vectorIndexDatabaseFilename());
  const installed = {
    bytes: 1,
    installed: true,
    modelId: manifest.id,
    partialBytes: 0,
    path: '/fake/model.gguf',
    verified: true,
  };
  const store = LocalModelStore.of({
    install: () => Effect.die('unexpected install'),
    path: () => installed.path,
    remove: () => Effect.succeed(false),
    status: () => Effect.succeed(installed),
    verify: () => Effect.succeed(installed),
  });
  const testContext = yield* Effect.context<FileSystem.FileSystem | Path.Path | SystemInfo>();
  let inputs = 0;
  let beforeInference = Effect.void as Effect.Effect<void, unknown>;
  const runtime = LocalModelRuntime.of({
    diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 1}),
    embedMany: request =>
      beforeInference.pipe(
        Effect.andThen(fs.exists(path.join(home, 'locks', 'indexes', 'vectors', manifest.id + '.lock'))),
        Effect.tap(locked => Effect.sync(() => expect(locked).toBe(false))),
        Effect.andThen(
          Effect.sync(() => {
            expect(request.inputs).toHaveLength(1);
            inputs += request.inputs.length;
            // Both the SQLite writer and model lock are released while native work executes.
            const db = new Database(filename);
            try {
              db.exec('BEGIN IMMEDIATE');
              db.exec('ROLLBACK');
            } finally {
              db.close();
            }
            return EffectArray.map(request.inputs, embeddingForInput);
          }),
        ),
        Effect.orDie,
      ),
    generate: () => Effect.die('unexpected generation'),
    rerank: () => Effect.die('unexpected rerank'),
  });
  const step = () =>
    stepRecallVectorPreparation(config, manifest, Effect.succeed(true)).pipe(
      Effect.provideService(LocalModelStore, store),
      Effect.provideService(LocalModelRuntime, runtime),
    );
  const finish = Effect.gen(function* () {
    for (let turn = 0; turn < 500; turn++) {
      const result = yield* step();
      if (result.state === 'current') return;
    }
    return yield* Effect.die('builder did not converge');
  });
  return {
    home,
    config,
    filename,
    index,
    resource,
    fs,
    step,
    finish,
    store,
    runtime,
    inputs: () => inputs,
    before: (program: Effect.Effect<void, unknown, FileSystem.FileSystem | Path.Path | SystemInfo>) => {
      beforeInference = program.pipe(Effect.provide(testContext));
    },
  };
});

describe('resumable recall vector preparation', () => {
  effectIt.effect('stops preparation at the time budget and omits an unfinished resolution denominator', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = yield* Path.Path;
      for (let index = 0; index < 101; index++)
        yield* f.fs.writeFileString(path.join(path.dirname(f.resource), `${index}.md`), `Document ${index}`);
      yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
      yield* f.step();
      yield* f.step();
      const clock = yield* Clock.Clock;
      let samples = 0;
      const result = yield* runRecallVectorPreparationBatch(f.config, manifest, Effect.succeed(true)).pipe(
        Effect.provideService(LocalModelStore, f.store),
        Effect.provideService(LocalModelRuntime, f.runtime),
        Effect.provideService(Clock.Clock, {
          ...clock,
          monotonicTimeNanos: Effect.sync(() => BigInt(samples++) * 251_000_000n),
        }),
      );
      expect(result.progress).toMatchObject({phase: 'resolve', completed: 100, total: 0});
      expect(f.inputs()).toBe(0);
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('keeps completed document preparation when an unfinished corpus is superseded', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = yield* Path.Path;
      const changing = path.join(path.dirname(f.resource), 'zz-changing.md');
      yield* f.fs.writeFileString(changing, 'Before source change');
      yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
      yield* f.step();
      yield* f.step();
      yield* f.step();
      expect((yield* preparationSnapshot(f.filename)).target).toMatchObject({phase: 'hydrate', cursor: 1});
      expect(f.inputs()).toBe(0);
      yield* f.fs.writeFileString(changing, 'After source change');
      yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
      yield* f.finish;
      yield* Effect.sync(() => {
        const db = new Database(f.filename, {readonly: true});
        try {
          expect(db.query('SELECT SUM(reused) AS reused FROM idle_recall_document_preparations').get()).toEqual({
            reused: 1,
          });
          expect(db.query('SELECT COUNT(*) AS count FROM vector_generations').get()).toEqual({count: 1});
        } finally {
          db.close();
        }
      });
    }).pipe(provideFixtureLayer(platform)),
  );

  for (const damage of ['missing', 'content', 'count'] as const)
    effectIt.effect(`rebuilds a ${damage} cached preparation instead of copying it`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.finish;
        yield* Effect.sync(() => {
          const db = new Database(f.filename);
          try {
            if (damage === 'missing')
              db.exec('DELETE FROM idle_recall_chunks WHERE chunk_id = (SELECT MIN(chunk_id) FROM idle_recall_chunks)');
            if (damage === 'content')
              db.exec(
                "UPDATE idle_recall_chunks SET content='invalid-json' WHERE chunk_id = (SELECT MIN(chunk_id) FROM idle_recall_chunks)",
              );
            if (damage === 'count') db.exec('UPDATE idle_recall_document_preparations SET chunk_count=0');
          } finally {
            db.close();
          }
        });
        const path = yield* Path.Path;
        yield* f.fs.writeFileString(path.join(path.dirname(f.resource), 'new.md'), 'New corpus member');
        yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
        yield* f.finish;
        yield* Effect.sync(() => {
          const db = new Database(f.filename, {readonly: true});
          try {
            expect(db.query('SELECT SUM(reused) AS reused FROM idle_recall_document_preparations').get()).toEqual({
              reused: 0,
            });
          } finally {
            db.close();
          }
        });
      }).pipe(provideFixtureLayer(platform)),
    );

  effectIt.effect('batches lightweight checkpoints while making at most one native request', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = yield* Path.Path;
      for (let index = 0; index < 40; index++)
        yield* f.fs.writeFileString(path.join(path.dirname(f.resource), `${index}.md`), `Document ${index}`);
      yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
      let before = 0;
      let largestPreparationAdvance = 0;
      for (let turn = 0; turn < 100; turn++) {
        const inferred = f.inputs();
        const result = yield* runRecallVectorPreparationBatch(f.config, manifest, Effect.succeed(true)).pipe(
          Effect.provideService(LocalModelStore, f.store),
          Effect.provideService(LocalModelRuntime, f.runtime),
        );
        expect(f.inputs() - inferred).toBeLessThanOrEqual(1);
        if (result.progress?.phase === 'hydrate') {
          largestPreparationAdvance = Math.max(largestPreparationAdvance, result.progress.completed - before);
          before = result.progress.completed;
          expect(result.progress.total).toBe(41);
        }
        if (result.state === 'current') break;
      }
      expect(largestPreparationAdvance).toBeGreaterThan(1);
      expect(
        yield* vectorIndexGenerationReadiness(
          f.home,
          manifest,
          (yield* loadRecallIndexData(f.config, {includeInactive: false})).generation,
        ),
      ).toBe('current');
    }).pipe(provideFixtureLayer(platform)),
  );

  fcEffectProp(
    effectIt,
    'preparation reused across corpus churn equals a clean build',
    {
      words: fc.array(fc.constantFrom('alpha', 'βeta', '😀', 'delta'), {minLength: 1, maxLength: 8}),
      repeats: fc.integer({min: 2, max: 40}),
    },
    ({words, repeats}) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const path = yield* Path.Path;
        const changed = path.join(path.dirname(f.resource), 'changing.md');
        yield* f.fs.writeFileString(changed, 'Initial independent document');
        yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
        yield* f.finish;
        const mapping = yield* Effect.acquireRelease(
          Effect.sync(() => vi.spyOn(recallVectorStorage, 'chunkMappings')),
          value => Effect.sync(() => value.mockRestore()),
        );
        yield* f.fs.writeFileString(
          changed,
          '# Changed\n\n' + EffectString.repeat(repeats)(EffectArray.join(words, ' ') + '\n'),
        );
        const current = yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
        yield* f.finish;
        expect(EffectArray.filter(mapping.mock.calls, ([candidates]) => candidates.length > 0)).toHaveLength(1);
        yield* Effect.sync(() => {
          const db = new Database(f.filename, {readonly: true});
          try {
            expect(db.query('SELECT SUM(reused) AS reused FROM idle_recall_document_preparations').get()).toEqual({
              reused: 1,
            });
            expect(db.query('SELECT COUNT(*) AS count FROM vector_generations').get()).toEqual({count: 1});
          } finally {
            db.close();
          }
        });
        const cleanHome = yield* f.fs.makeTempDirectoryScoped({prefix: 'recall-churn-clean-'});
        yield* ensureVectorIndex({agentContextHome: cleanHome}, manifest, current.candidates, {
          corpusGeneration: current.generation,
        }).pipe(
          Effect.provideService(LocalModelStore, f.store),
          Effect.provideService(LocalModelRuntime, {
            ...f.runtime,
            embedMany: ({inputs}) => Effect.succeed(EffectArray.map(inputs, embeddingForInput)),
          }),
        );
        expect(yield* vectorSnapshot(f.filename)).toEqual(
          yield* vectorSnapshot(path.join(cleanHome, 'indexes/vectors', manifest.id, vectorIndexDatabaseFilename())),
        );
      }).pipe(provideFixtureLayer(platform)),
    {fastCheck: {numRuns: 8}},
  );

  effectIt.effect('upgrades an exact legacy target identity without resetting its durable cursor', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const source = yield* openRecallVectorPreparationSource(f.config);
      const first = yield* recallVectorTarget(f.config, manifest, source);
      yield* prepareRecallVectorMetadata(f.config, manifest, source, first);
      const checkpoint = yield* recallVectorTarget(f.config, manifest, source);
      const legacyJob = sha256HexSync(
        JSON.stringify([
          'idle-recall-v1',
          recallEmbeddingDemandKey(f.config),
          source.generation,
          source.authorizationKey,
          manifest.id,
          recallVectorStorage.recipe(manifest),
          RECALL_CHUNKER_VERSION,
        ]),
      );
      yield* Effect.acquireUseRelease(
        Effect.sync(() => new Database(f.filename)),
        db =>
          Effect.sync(() =>
            db.query('UPDATE vector_generations SET job_id=? WHERE generation=?').run(legacyJob, checkpoint.generation),
          ),
        db => Effect.sync(() => db.close()),
      );
      expect(yield* recallVectorTarget(f.config, manifest, source)).toEqual(checkpoint);
      expect(yield* recallVectorTarget({...f.config, user: 'another-user'}, manifest, source)).toEqual(checkpoint);
      expect(f.inputs()).toBe(0);
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect(
    'shares computation across equivalent scopes while retaining authorization separation and cursor',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const source = yield* openRecallVectorPreparationSource(f.config);
        const otherScope = {...f.config, user: 'another-user'};

        const first = yield* recallVectorTarget(f.config, manifest, source);
        yield* prepareRecallVectorMetadata(f.config, manifest, source, first);
        const checkpoint = yield* recallVectorTarget(f.config, manifest, source);
        expect(checkpoint.phase).toBe('resolve');
        yield* loadRecallIndexData(otherScope, {includeInactive: false, memoryIds: []});
        const otherSource = yield* openRecallVectorPreparationSource(otherScope);
        expect(otherSource.generation).toBe(source.generation);
        expect(otherSource.authorizationKey).toBe(source.authorizationKey);
        expect(yield* recallVectorTarget(otherScope, manifest, otherSource)).toEqual(checkpoint);
        const distinct = yield* recallVectorTarget(otherScope, manifest, {
          ...otherSource,
          authorizationKey: 'distinct-authority',
        });
        expect(distinct.generation).not.toBe(checkpoint.generation);
        expect(yield* recallVectorTarget(f.config, manifest, source)).toEqual(checkpoint);
        expect(f.inputs()).toBe(0);
      }).pipe(provideFixtureLayer(platform)),
  );

  effectIt.effect(
    'distinct live authorization scopes both finish and query fallback requeues the displaced scope',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const other = {...f.config, user: 'second'};
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi
              .spyOn(ExternalResources, 'loadExternalResourceAccess')
              .mockImplementation(location =>
                Effect.succeed<Record<string, string>>(
                  location.user === 'second' ? {'resources/external/github/source/docs/doc/chunk.md': 'hash'} : {},
                ),
              ),
          ),
          () =>
            Effect.gen(function* () {
              const stepOther = loadRecallIndexData(other, {includeInactive: false, memoryIds: []}).pipe(
                Effect.andThen(stepRecallVectorPreparation(other, manifest, Effect.succeed(true))),
                Effect.provideService(LocalModelStore, f.store),
                Effect.provideService(LocalModelRuntime, f.runtime),
              );
              let firstDone = false;
              let secondDone = false;
              for (let turn = 0; turn < 500 && !(firstDone && secondDone); turn++) {
                if (!firstDone) {
                  yield* loadRecallIndexData(f.config, {includeInactive: false, memoryIds: []});
                  firstDone = (yield* f.step()).state === 'current';
                }
                if (!secondDone) secondDone = (yield* stepOther).state === 'current';
              }
              expect(firstDone && secondDone).toBe(true);
              expect((yield* stepOther).state).toBe('current');
              const firstKey = yield* loadRecallVectorAuthorizationKey(f.config);
              const secondKey = yield* loadRecallVectorAuthorizationKey(other);
              expect(firstKey).not.toBe(secondKey);
              expect(yield* vectorIndexGenerationReadiness(f.home, manifest, f.index.generation, firstKey)).toBe(
                'stale',
              );
              expect(yield* vectorIndexGenerationReadiness(f.home, manifest, f.index.generation, secondKey)).toBe(
                'current',
              );
              const before = f.inputs();
              expect(
                yield* selectedSemanticScores(f.config, 'example', {corpusGeneration: f.index.generation}).pipe(
                  Effect.provideService(LocalModelStore, f.store),
                  Effect.provideService(LocalModelRuntime, f.runtime),
                ),
              ).toBeUndefined();
              expect(f.inputs()).toBe(before);
              yield* loadRecallIndexData(f.config, {includeInactive: false, memoryIds: []});
              yield* f.finish;
              expect(yield* vectorIndexGenerationReadiness(f.home, manifest, f.index.generation, firstKey)).toBe(
                'current',
              );
            }),
          mock => Effect.sync(() => mock.mockRestore()),
        );
      }).pipe(provideFixtureLayer(platform)),
  );

  effectIt.effect('rejects a live authorization-map change during query inference or ready reactivation', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.finish;
      let changed = false;
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          vi
            .spyOn(ExternalResources, 'loadExternalResourceAccess')
            .mockImplementation(() =>
              Effect.succeed<Record<string, string>>(changed ? {'new-external-uri': 'hash'} : {}),
            ),
        ),
        () =>
          Effect.gen(function* () {
            f.before(
              Effect.sync(() => {
                changed = true;
              }),
            );
            expect(
              yield* selectedSemanticScores(f.config, 'query', {corpusGeneration: f.index.generation}).pipe(
                Effect.provideService(LocalModelStore, f.store),
                Effect.provideService(LocalModelRuntime, f.runtime),
              ),
            ).toBeUndefined();
            changed = false;
            let checks = 0;
            const step = stepRecallVectorPreparation(
              f.config,
              manifest,
              Effect.sync(() => {
                if (++checks === 2) changed = true;
                return true;
              }),
            ).pipe(
              Effect.provideService(LocalModelStore, f.store),
              Effect.provideService(LocalModelRuntime, f.runtime),
            );
            expect((yield* step.pipe(Effect.result))._tag).toBe('Failure');
            changed = false;
            const before = f.inputs();
            expect((yield* f.step()).state).toBe('current');
            expect(f.inputs()).toBe(before);
          }),
        mock => Effect.sync(() => mock.mockRestore()),
      );
    }).pipe(provideFixtureLayer(platform)),
  );

  for (const corruption of ['malformed', 'missing'] as const)
    effectIt.effect(`refuses ${corruption} inactive ready vectors without replacing a healthy active pointer`, () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.finish;
        const original = yield* recallVectorTarget(
          f.config,
          manifest,
          yield* openRecallVectorPreparationSource(f.config),
        );
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi
              .spyOn(ExternalResources, 'loadExternalResourceAccess')
              .mockImplementation(location =>
                Effect.succeed<Record<string, string>>(location.user === 'second' ? {'other-authority': 'hash'} : {}),
              ),
          ),
          () =>
            Effect.gen(function* () {
              const other = {...f.config, user: 'second'};
              yield* loadRecallIndexData(other, {includeInactive: false, memoryIds: []});
              for (let turn = 0; turn < 500; turn++) {
                const result = yield* stepRecallVectorPreparation(other, manifest, Effect.succeed(true)).pipe(
                  Effect.provideService(LocalModelStore, f.store),
                  Effect.provideService(LocalModelRuntime, f.runtime),
                );
                if (result.state === 'current') break;
              }
              expect((yield* vectorIndexStatus(f.home, manifest)).ready).toBe(true);
              yield* Effect.sync(() => {
                const db = new Database(f.filename);
                try {
                  db.exec('PRAGMA foreign_keys=OFF');
                  let id = 999999;
                  if (corruption === 'malformed') {
                    db.query('INSERT INTO vector_values (vector_key,vector) VALUES (?,?)').run(
                      'corrupt-inactive',
                      new Uint8Array([0]),
                    );
                    id = db
                      .query<{id: number}, [string]>('SELECT id FROM vector_values WHERE vector_key=?')
                      .get('corrupt-inactive')!.id;
                  }
                  db.query(
                    'UPDATE vector_chunks SET vector_id=? WHERE generation=? AND chunk_id=(SELECT MIN(chunk_id) FROM vector_chunks WHERE generation=?)',
                  ).run(id, original.generation, original.generation);
                } finally {
                  db.close();
                }
              });
              yield* loadRecallIndexData(f.config, {includeInactive: false, memoryIds: []});
              const before = f.inputs();
              expect(yield* f.step().pipe(Effect.result)).toMatchObject({
                _tag: 'Failure',
                failure: {_tag: 'VectorIndexCorrupt'},
              });
              expect(f.inputs()).toBe(before);
              expect((yield* vectorIndexStatus(f.home, manifest)).ready).toBe(true);
              expect(
                yield* vectorIndexGenerationReadiness(
                  f.home,
                  manifest,
                  f.index.generation,
                  yield* loadRecallVectorAuthorizationKey(other),
                ),
              ).toBe('current');
              expect(
                (yield* recallVectorTarget(f.config, manifest, yield* openRecallVectorPreparationSource(f.config)))
                  .phase,
              ).toBe('ready');
            }),
          mock => Effect.sync(() => mock.mockRestore()),
        );
      }).pipe(provideFixtureLayer(platform)),
    );

  effectIt.effect('retiring one target preserves another current-corpus unfinished checkpoint and prepared rows', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const source = yield* openRecallVectorPreparationSource(f.config);
      const otherSource = {...source, authorizationKey: 'other-live-authority'};
      const other = yield* recallVectorTarget(f.config, manifest, otherSource);
      yield* prepareRecallVectorMetadata(f.config, manifest, otherSource, other);
      const checkpoint = yield* recallVectorTarget(f.config, manifest, otherSource);
      const observe = Effect.acquireUseRelease(
        Effect.sync(() => new Database(f.filename, {readonly: true})),
        db =>
          Effect.sync(() => ({
            metadata: db
              .query<{count: number}, [string]>('SELECT COUNT(*) AS count FROM idle_recall_metadata WHERE generation=?')
              .get(other.generation)!.count,
            state: db
              .query<{state: string}, [string]>('SELECT state FROM vector_generations WHERE generation=?')
              .get(other.generation)!.state,
          })),
        db => Effect.sync(() => db.close()),
      );
      const before = yield* observe;
      expect(before.metadata).toBeGreaterThan(0);
      expect(before.state).toBe('building');
      yield* f.finish;
      expect(yield* recallVectorTarget(f.config, manifest, otherSource)).toEqual(checkpoint);
      expect(yield* observe).toEqual(before);
      expect(yield* vectorIndexGenerationReadiness(f.home, manifest, f.index.generation)).toBe('current');
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('checkpoints one input at a time, resumes without re-embedding, and reuses content values', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let inferenceTurns = 0;
      for (let turn = 0; turn < 100; turn++) {
        const before = f.inputs();
        const result = yield* f.step();
        expect(f.inputs() - before).toBeLessThanOrEqual(1);
        if (f.inputs() > before) inferenceTurns++;
        if (result.state === 'current') break;
        if (result.phase !== 'retire' && result.phase !== 'ready')
          expect(yield* vectorIndexGenerationReadiness(f.home, manifest, f.index.generation)).not.toBe('current');
      }
      expect(inferenceTurns).toBeGreaterThan(1);
      expect(yield* vectorIndexGenerationReadiness(f.home, manifest, f.index.generation)).toBe('current');
      const before = f.inputs();
      yield* f.finish;
      expect(f.inputs()).toBe(before);
      const scores = yield* selectedSemanticScores(f.config, 'bounded').pipe(
        Effect.provideService(LocalModelStore, f.store),
        Effect.provideService(LocalModelRuntime, f.runtime),
      );
      expect(scores?.size).toBe(1);
    }).pipe(provideFixtureLayer(platform)),
  );
  fcEffectProp(
    effectIt,
    'resumed background publication equals a clean foreground build for varied chunk boundaries',
    {
      words: fc.array(fc.constantFrom('alpha', 'βeta', 'gamma', '😀', 'delta'), {minLength: 1, maxLength: 15}),
      repeats: fc.integer({min: 10, max: 250}),
    },
    ({words, repeats}) => cleanBuildEquivalent(words, repeats),
    {fastCheck: {numRuns: 8}},
  );
  effectIt.effect(
    'preserves surrogate boundary fragments through durable preparation and the clean foreground oracle',
    () => cleanBuildEquivalent(['βeta', 'alpha', '😀'], 213),
  );
  effectIt.effect('resumes the durable global-resolution output cursor after losing its optional metadata cache', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = yield* Path.Path;
      for (let index = 0; index < 200; index++)
        yield* f.fs.writeFileString(
          path.join(path.dirname(f.resource), String(index) + '.md'),
          'Separate corpus document ' + String(index),
        );
      yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
      for (let turn = 0; turn < 4; turn++) yield* f.step();
      const inspect = () =>
        Effect.sync(() => {
          const db = new Database(f.filename, {readonly: true});
          try {
            return db
              .query<{generation: string; phase: string; cursor: number}, []>(
                'SELECT generation,phase,cursor FROM idle_recall_targets ORDER BY generation DESC LIMIT 1',
              )
              .get()!;
          } finally {
            db.close();
          }
        });
      const first = yield* inspect();
      expect(first).toMatchObject({phase: 'resolve', cursor: 100});
      releaseResolvedRecallMetadata(first.generation);
      yield* f.step();
      expect(yield* inspect()).toMatchObject({phase: 'resolve', cursor: 200});
      yield* f.step();
      expect(yield* inspect()).toMatchObject({phase: 'hydrate', cursor: 0});
      yield* Effect.sync(() => {
        const db = new Database(f.filename, {readonly: true});
        try {
          expect(db.query('SELECT COUNT(*) AS count FROM idle_recall_documents').get()).toEqual({count: 201});
        } finally {
          db.close();
        }
      });
      expect(f.inputs()).toBe(0);
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('resumes a document beyond one hundred chunk and alias rows after losing its cache', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.fs.writeFileString(
        f.resource,
        EffectArray.join(
          EffectArray.makeBy(125, n => '# Section ' + String(n) + '\n\nDistinct section payload ' + String(n)),
          '\n\n',
        ),
      );
      const index = yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
      yield* f.step();
      yield* f.step();
      yield* f.step();
      const first = yield* preparationSnapshot(f.filename);
      expect(first.target).toMatchObject({phase: 'hydrate', cursor: 0, chunk_cursor: 100, alias_cursor: 0});
      expect(first.chunks).toHaveLength(100);
      releasePreparedRecallDocument(first.target.generation);
      yield* f.step();
      const resumed = yield* preparationSnapshot(f.filename);
      expect(resumed.target).toMatchObject({phase: 'hydrate', cursor: 1, chunk_cursor: 0, alias_cursor: 0});
      expect(resumed.chunks).toHaveLength(125);
      expect(
        resumed.chunks.length + resumed.aliases.length - first.chunks.length - first.aliases.length,
      ).toBeLessThanOrEqual(100);
      expect(
        EffectArray.every(first.chunks, chunk =>
          EffectArray.some(resumed.chunks, row => row.chunk_id === chunk.chunk_id),
        ),
      ).toBe(true);
      yield* f.finish;
      const cleanHome = yield* f.fs.makeTempDirectoryScoped({prefix: 'recall-large-clean-'});
      yield* ensureVectorIndex({agentContextHome: cleanHome}, manifest, index.candidates, {
        corpusGeneration: index.generation,
      }).pipe(
        Effect.provideService(LocalModelStore, f.store),
        Effect.provideService(LocalModelRuntime, {
          ...f.runtime,
          embedMany: ({inputs}) => Effect.succeed(EffectArray.map(inputs, embeddingForInput)),
        }),
      );
      expect(yield* vectorSnapshot(f.filename)).toEqual(
        yield* vectorSnapshot(
          (yield* Path.Path).join(cleanHome, 'indexes/vectors', manifest.id, vectorIndexDatabaseFilename()),
        ),
      );
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('uses indexed URI and chunk cursor lookups in the actual production SQL without ANALYZE', () =>
    Effect.gen(function* () {
      const spy = yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(Database.prototype, 'query')),
        value => Effect.sync(() => value.mockRestore()),
      );
      const f = yield* fixture;
      yield* f.finish;
      const queries = EffectArray.map(spy.mock.calls, args => args[0]);
      const uriLookup = Option.getOrThrow(
        EffectArray.findFirst(queries, query =>
          EffectString.includes("json_extract(candidate_json, '$.uri') =")(query),
        ),
      );
      const chunkLookup = Option.getOrThrow(
        EffectArray.findFirst(queries, query =>
          EffectString.includes('SELECT p.*, v.vector AS existing_vector')(query),
        ),
      );
      expect(uriLookup).toBeDefined();
      expect(chunkLookup).toBeDefined();
      yield* Effect.sync(() => {
        const db = new Database(f.filename);
        try {
          const row = db
            .query<{generation: string; candidate_json: string}, []>(
              'SELECT generation,candidate_json FROM idle_recall_documents LIMIT 1',
            )
            .get()!;
          const insert = db.query(
            'INSERT INTO idle_recall_documents (generation,ordinal,candidate_json,candidate_sha256) VALUES (?,?,?,?)',
          );
          db.transaction(() => {
            for (let ordinal = 1; ordinal < 1000; ordinal++) {
              const candidate = JSON.stringify({
                ...JSON.parse(row.candidate_json),
                uri: 'threadnote://resources/extra-' + String(ordinal),
              });
              insert.run(row.generation, ordinal, candidate, sha256HexSync(candidate));
            }
          })();
          const uriPlan = db
            .query<{detail: string}, [string, string]>('EXPLAIN QUERY PLAN ' + uriLookup)
            .all(row.generation, JSON.parse(row.candidate_json).uri);
          const chunkPlan = db
            .query<{detail: string}, [string, string]>('EXPLAIN QUERY PLAN ' + chunkLookup)
            .all(row.generation, '');
          expect(
            EffectArray.some(uriPlan, row =>
              /USING INDEX idle_recall_documents_uri.*generation=.*<expr>=/.test(row.detail),
            ),
          ).toBe(true);
          expect(
            EffectArray.some(chunkPlan, row => /SEARCH p USING PRIMARY KEY.*generation=.*chunk_id>/.test(row.detail)),
          ).toBe(true);
        } finally {
          db.close();
        }
      });
    }).pipe(provideFixtureLayer(platform)),
  );
  for (const corruption of ['content', 'fingerprint', 'vector_key', 'candidate_json'] as const) {
    effectIt.effect('rejects prepared ' + corruption + ' corruption before inference or publication', () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (let turn = 0; turn < 4; turn++) yield* f.step();
        expect((yield* preparationSnapshot(f.filename)).target.phase).toBe('embed');
        yield* Effect.sync(() => {
          const db = new Database(f.filename);
          try {
            if (corruption === 'candidate_json')
              db.exec(
                "UPDATE idle_recall_documents SET candidate_json = json_set(candidate_json,'$.project','poisoned')",
              );
            else db.exec('UPDATE idle_recall_chunks SET ' + corruption + " = 'poisoned'");
          } finally {
            db.close();
          }
        });
        expect((yield* f.step().pipe(Effect.result))._tag).toBe('Failure');
        expect(f.inputs()).toBe(0);
        expect(yield* vectorIndexGenerationReadiness(f.home, manifest, f.index.generation)).not.toBe('current');
      }).pipe(provideFixtureLayer(platform)),
    );
  }
  effectIt.effect('never publishes after a corpus change during inference', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.before(
        f.fs
          .writeFileString(f.resource, '# New canonical body')
          .pipe(Effect.andThen(expireRecallIndexValidation(f.home, false)), Effect.asVoid),
      );
      let failed = false;
      for (let turn = 0; turn < 20; turn++) {
        const result = yield* f.step().pipe(Effect.result);
        if (result._tag === 'Failure') {
          failed = true;
          break;
        }
      }
      expect(failed).toBe(true);
      expect(yield* vectorIndexGenerationReadiness(f.home, manifest, f.index.generation)).not.toBe('current');
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('does not resurrect a generation deleted by a manual writer during inference', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.before(
        Effect.sync(() => {
          const db = new Database(f.filename);
          try {
            db.exec("PRAGMA foreign_keys = ON; DELETE FROM vector_generations WHERE state = 'building'");
          } finally {
            db.close();
          }
        }),
      );
      let failed = false;
      for (let turn = 0; turn < 20; turn++) {
        const result = yield* f.step().pipe(Effect.result);
        if (result._tag === 'Failure') {
          failed = true;
          break;
        }
      }
      expect(failed).toBe(true);
      expect(yield* vectorIndexGenerationReadiness(f.home, manifest, f.index.generation)).not.toBe('current');
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect(
    'bounds retained generations and retains only current document preparation across canonical churn',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        for (let generation = 0; generation < 4; generation++) {
          if (generation) {
            yield* f.fs.writeFileString(f.resource, 'New canonical generation ' + String(generation));
            yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
          }
          yield* f.finish;
          yield* Effect.sync(() => {
            const db = new Database(f.filename, {readonly: true});
            try {
              expect(db.query('SELECT COUNT(*) AS count FROM vector_generations').get()).toEqual({count: 1});
              expect(db.query('SELECT COUNT(*) AS count FROM idle_recall_chunks').get()).toEqual(
                db.query('SELECT COUNT(*) AS count FROM vector_chunks').get(),
              );
              expect(db.query('SELECT COUNT(*) AS count FROM idle_recall_metadata').get()).toEqual({count: 0});
              expect(db.query('SELECT COUNT(*) AS count FROM idle_recall_documents').get()).toEqual({count: 1});
              expect(db.query('SELECT COUNT(*) AS count FROM vector_values').get()).toEqual({
                count: generation ? 1 : f.inputs(),
              });
            } finally {
              db.close();
            }
          });
        }
      }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('reactivates an authorized immutable ready target without repeating inference', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.finish;
      yield* Effect.sync(() => {
        const db = new Database(f.filename);
        try {
          db.exec('DELETE FROM vector_pointer');
        } finally {
          db.close();
        }
      });
      const before = f.inputs();
      expect((yield* f.step()).state).toBe('current');
      expect(f.inputs()).toBe(before);
      expect(yield* vectorIndexGenerationReadiness(f.home, manifest, f.index.generation)).toBe('current');
    }).pipe(provideFixtureLayer(platform)),
  );
  effectIt.effect('keeps unknown existing schema untouched for manual repair', () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const path = yield* Path.Path;
      yield* f.fs.makeDirectory(path.dirname(f.filename), {recursive: true});
      yield* Effect.sync(() => {
        const db = new Database(f.filename);
        try {
          db.exec(
            "CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('keep'); PRAGMA user_version = 999",
          );
        } finally {
          db.close();
        }
      });
      expect((yield* f.step().pipe(Effect.result))._tag).toBe('Failure');
      yield* Effect.sync(() => {
        const db = new Database(f.filename);
        try {
          expect(db.query('SELECT value FROM sentinel').get()).toEqual({value: 'keep'});
          expect(db.query('PRAGMA user_version').get()).toEqual({user_version: 999});
        } finally {
          db.close();
        }
      });
    }).pipe(provideFixtureLayer(platform)),
  );
});

function provideFixtureLayer<Services, E, R>(layer: Layer.Layer<Services, E, R>) {
  return <A, E2, R2>(program: Effect.Effect<A, E2, R2>) =>
    Effect.scoped(Layer.build(layer).pipe(Effect.flatMap(context => program.pipe(Effect.provide(context)))));
}

function embeddingForInput(input: string): number[] {
  const hash = sha256HexSync(input);
  return [
    0.1 + Number.parseInt(EffectString.slice(0, 8)(hash), 16) / 0xffffffff,
    0.1 + Number.parseInt(EffectString.slice(8, 16)(hash), 16) / 0xffffffff,
  ];
}
const vectorSnapshot = (filename: string) =>
  Effect.sync(() => {
    const db = new Database(filename, {readonly: true});
    try {
      return {
        chunks: db
          .query(
            `SELECT c.chunk_id,c.uri,c.fingerprint,c.project,c.approved_authoritative,v.vector_key,hex(v.vector) AS vector
        FROM vector_pointer p JOIN vector_chunks c ON c.generation = p.generation JOIN vector_values v ON v.id = c.vector_id ORDER BY c.chunk_id`,
          )
          .all(),
        aliases: db
          .query(
            'SELECT a.uri,a.representative_uri FROM vector_pointer p JOIN vector_aliases a ON a.generation = p.generation ORDER BY a.uri',
          )
          .all(),
      };
    } finally {
      db.close();
    }
  });
const preparationSnapshot = (filename: string) =>
  Effect.sync(() => {
    const db = new Database(filename, {readonly: true});
    try {
      return {
        target: db
          .query<{generation: string; phase: string; cursor: number; chunk_cursor: number; alias_cursor: number}, []>(
            'SELECT * FROM idle_recall_targets ORDER BY generation DESC LIMIT 1',
          )
          .get()!,
        chunks: db.query<{chunk_id: string}, []>('SELECT chunk_id FROM idle_recall_chunks ORDER BY chunk_id').all(),
        aliases: db.query('SELECT * FROM vector_aliases').all(),
      };
    } finally {
      db.close();
    }
  });

function cleanBuildEquivalent(words: readonly string[], repeats: number) {
  return Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.fs.writeFileString(
      f.resource,
      '# Varied document\n\n' + EffectString.repeat(repeats)(EffectArray.join(words, ' ') + '\n'),
    );
    const index = yield* loadRecallIndexData(f.config, {forceRefresh: true, includeInactive: false});
    yield* f.finish;
    const cleanHome = yield* f.fs.makeTempDirectoryScoped({prefix: 'recall-clean-oracle-'});
    const cleanRuntime = LocalModelRuntime.of({
      ...f.runtime,
      embedMany: ({inputs}) => Effect.succeed(EffectArray.map(inputs, embeddingForInput)),
    });
    yield* ensureVectorIndex({agentContextHome: cleanHome}, manifest, index.candidates, {
      corpusGeneration: index.generation,
    }).pipe(Effect.provideService(LocalModelStore, f.store), Effect.provideService(LocalModelRuntime, cleanRuntime));
    const path = yield* Path.Path;
    const cleanFilename = path.join(cleanHome, 'indexes/vectors', manifest.id, vectorIndexDatabaseFilename());
    expect(yield* vectorSnapshot(f.filename)).toEqual(yield* vectorSnapshot(cleanFilename));
  }).pipe(provideFixtureLayer(platform));
}
