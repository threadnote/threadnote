import {fcEffectProp} from '@threadnote/testing/fast-check-property';
import fc from 'fast-check';
import {releasePreparedRecallDocument, releaseResolvedRecallMetadata} from '../src/background/vector-preparation.js';
import * as EffectString from 'effect/String';
import * as BunServices from '@effect/platform-bun/BunServices';
import {it as effectIt} from '@effect/vitest';
import {Database} from 'bun:sqlite';
import {Array as EffectArray, Effect, FileSystem, Layer, Option, Path} from 'effect';
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
  ensureVectorIndex,
  vectorIndexDatabaseFilename,
  selectedSemanticScores,
} from '../src/vector-index.js';
import {stepRecallVectorPreparation} from '../src/background/vector-step.js';

const manifest = {
  ...Option.getOrThrow(EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.role === 'embedding')),
  dimensions: 2,
  promptPrefixes: {document: 'document: ', query: 'query: '},
};
const platform = Layer.mergeAll(
  BunServices.layer,
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
        if (result.phase !== 'retire')
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
  effectIt.effect('bounds retained generations and removes prepared document bodies across canonical churn', () =>
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
            expect(db.query('SELECT COUNT(*) AS count FROM idle_recall_chunks').get()).toEqual({count: 0});
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
  effectIt.effect('never clears demand from a retained ready target whose active pointer was removed', () =>
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
      expect((yield* f.step().pipe(Effect.result))._tag).toBe('Failure');
      expect(yield* vectorIndexGenerationReadiness(f.home, manifest, f.index.generation)).not.toBe('current');
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
