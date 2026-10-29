import {Array as EffectArray} from 'effect';
import {TestError} from '@threadnote/testing/test-error';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {Database, type SQLQueryBindings} from 'bun:sqlite';
import {join} from '@threadnote/testing/node-path';
import {Effect, Layer, Option, Result} from 'effect';
import {describe, expect, it} from 'vitest';
import {InferenceInterrupted} from '@threadnote/inference/engine/errors';
import {LocalModelRuntime} from '@threadnote/inference/engine/local-model-runtime';
import {BUILTIN_MODEL_MANIFESTS} from '@threadnote/inference/models/builtin';
import {LocalModelCatalog} from '@threadnote/inference/models/catalog';
import {selectLocalModel} from '@threadnote/inference/models/selection';
import {LocalModelStore, type LocalModelStoreShape} from '@threadnote/inference/models/store';
import {loadRecallIndexData} from '@threadnote/recall/index';
import {loadMcpRecallSemanticScoresResult, loadRecallSemanticScores} from '@threadnote/recall/runtime';
import {
  ensureVectorIndex,
  purgeVectorIndex,
  rebuildVectorIndex,
  selectedSemanticScores,
  VectorCorpusGenerationChanged,
  vectorIndexDatabaseFilename,
  vectorIndexMatchesGeneration,
  vectorIndexStatus,
} from '@threadnote/recall/vector-index';
import {mkdir, mkdtemp, rm, stat, writeFile} from '../helpers/effect-filesystem.js';
import {runEffect} from '../helpers/effect-runtime.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

function requiredRow<Row extends object>(row: Row | null): Row {
  if (row === null) throw TestError.make({message: 'Expected a row for a required SQLite query result.'});
  return row;
}

const manifest = Option.getOrUndefined(
  EffectArray.findFirst(BUILTIN_MODEL_MANIFESTS, model => model.id === 'bge-small-en-v1.5-q8'),
)!;

const modelStoreLayer = Layer.succeed(
  LocalModelStore,
  LocalModelStore.of({
    install: () => Effect.die(TestError.make({message: 'Unexpected install'})),
    path: home => `${home}/models/fake.gguf`,
    remove: () => Effect.succeed(false),
    status: home => Effect.succeed(installation(home)),
    verify: home => Effect.succeed(installation(home)),
  } satisfies LocalModelStoreShape),
);

describe('vector index generations', () => {
  it('embeds Ukrainian natural-language candidate content', async () => {
    const home = await mkdtemp('threadnote-vector-ukrainian-');
    const embeddedInputs: string[] = [];
    try {
      const rebuilt = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, [
          {
            text: '# Київська зустріч\n\nПам’ять про розмову та український борщ.',
            uri: 'threadnote://resources/repos/ukrainian.md',
          },
        ]).pipe(
          provideTestLayer(
            fakeRuntimeLayer(
              () => 0,
              inputs => embeddedInputs.push(...inputs),
            ),
          ),
          provideTestLayer(modelStoreLayer),
        ),
      );

      expect(rebuilt).toMatchObject({chunkCount: 1, embeddedChunkCount: 1, ready: true});
      expect(embeddedInputs).toHaveLength(1);
      expect(embeddedInputs[0]).toContain('Пам’ять про розмову та український борщ');
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('activates a complete fake-embedding generation and supports semantic query lookup', async () => {
    const home = await mkdtemp('threadnote-vector-index-');
    try {
      const runtimeLayer = fakeRuntimeLayer(input =>
        Effect2.pipe(input, EffectString.toLowerCase, EffectString.includes('alpha')) ? 0 : 1,
      );
      const effect = Effect.gen(function* () {
        const catalog = yield* LocalModelCatalog;
        yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
        const rebuilt = yield* rebuildVectorIndex({agentContextHome: home}, manifest, [
          {
            equivalentUris: ['threadnote://user/me/memories/shared/team-b/durable/projects/demo/a.md'],
            text: '# Alpha\n\nThe release semaphore controls deployment.',
            uri: 'threadnote://resources/repos/a.md',
          },
          {
            equivalentUris: Array.from(
              {length: 250},
              (_, index) => `threadnote://user/me/memories/shared/team-${index}/durable/projects/demo/irrelevant.md`,
            ),
            text: '# Beta\n\nThe orchard contains pear trees.',
            uri: 'threadnote://resources/repos/b.md',
          },
        ]);
        const scores = yield* selectedSemanticScores({agentContextHome: home}, 'alpha deployment', {limit: 1});
        return {rebuilt, scores};
      }).pipe(provideTestLayer(runtimeLayer), provideTestLayer(modelStoreLayer));
      const {rebuilt, scores} = await runEffect(effect);
      expect(rebuilt.ready).toBe(true);
      expect(rebuilt.chunkCount).toBe(2);
      expect(scores?.get('threadnote://resources/repos/a.md')).toBeCloseTo(1);
      expect(scores?.get('threadnote://user/me/memories/shared/team-b/durable/projects/demo/a.md')).toBeCloseTo(1);
      expect(scores?.has('threadnote://resources/repos/b.md')).toBe(false);
      expect(
        EffectArray.some(
          [...(scores?.keys() ?? [])],
          __effectArrayValue =>
            !!(uri =>
              Effect2.pipe(uri, EffectString.includes('/shared/team-')) &&
              Effect2.pipe(uri, EffectString.endsWith('/irrelevant.md')))(__effectArrayValue),
        ),
      ).toBe(false);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('stores vectors as bounded SQLite rows and removes legacy sidecar artifacts after activation', async () => {
    const home = await mkdtemp('threadnote-vector-sqlite-');
    const root = join(home, 'indexes', 'vectors', manifest.id);
    const legacyGeneration = join(root, 'generations', 'legacy');
    try {
      await mkdir(legacyGeneration, {recursive: true});
      await mkdir(join(root, 'staging'), {recursive: true});
      await writeFile(join(root, 'active.json'), '{"version":1}', 'utf8');
      await writeFile(join(legacyGeneration, 'vectors.bin'), 'legacy', 'utf8');
      await writeFile(join(root, 'vectors-v4.sqlite'), 'legacy', 'utf8');

      const rebuilt = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, [
          {text: '# Alpha\n\nSQLite vector rows.', uri: 'threadnote://resources/repos/a.md'},
          {text: '# Beta\n\nPaged exact search.', uri: 'threadnote://resources/repos/b.md'},
        ]).pipe(
          provideTestLayer(fakeRuntimeLayer(input => (Effect2.pipe(input, EffectString.includes('Alpha')) ? 0 : 1))),
          provideTestLayer(modelStoreLayer),
        ),
      );

      const database = new Database(vectorDatabasePath(home), {readonly: true});
      try {
        expect(database.query('PRAGMA user_version').get()).toEqual({user_version: 5});
        expect(database.query('SELECT COUNT(*) AS count FROM vector_chunks').get()).toEqual({count: 2});
        expect(database.query('SELECT COUNT(*) AS count FROM vector_values').get()).toEqual({count: 2});
        expect(database.query('SELECT MIN(length(vector)) AS bytes FROM vector_values').get()).toEqual({
          bytes: manifest.dimensions * 4,
        });
        expect(database.query('SELECT state FROM vector_generations').all()).toEqual([{state: 'ready'}]);
        expect(
          database
            .query(
              `SELECT name
               FROM sqlite_master
               WHERE type = 'index'
                 AND name IN (
                   'vector_aliases_by_representative',
                   'vector_chunks_by_authority',
                   'vector_chunks_by_project',
                   'vector_chunks_by_uri'
                 )
               ORDER BY name`,
            )
            .all(),
        ).toEqual([
          {name: 'vector_aliases_by_representative'},
          {name: 'vector_chunks_by_authority'},
          {name: 'vector_chunks_by_project'},
          {name: 'vector_chunks_by_uri'},
        ]);
      } finally {
        database.close();
      }
      expect(rebuilt.chunkCount).toBe(2);
      await expect(stat(join(root, 'active.json'))).rejects.toThrow();
      await expect(stat(join(root, 'generations'))).rejects.toThrow();
      await expect(stat(join(root, 'staging'))).rejects.toThrow();
      await expect(stat(join(root, 'vectors-v4.sqlite'))).rejects.toThrow();
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it.each([1, 999])(
    'recreates vector schema version %i through the updater-facing ensure path',
    async schemaVersion => {
      const home = await mkdtemp('threadnote-vector-schema-');
      const candidates = [{text: '# Alpha\n\nSchema recovery.', uri: 'threadnote://resources/repos/a.md'}];
      try {
        const runtimeLayer = fakeRuntimeLayer(() => 0);
        await runEffect(
          rebuildVectorIndex({agentContextHome: home}, manifest, candidates).pipe(
            provideTestLayer(runtimeLayer),
            provideTestLayer(modelStoreLayer),
          ),
        );
        const incompatible = new Database(vectorDatabasePath(home));
        incompatible.exec(`PRAGMA user_version = ${schemaVersion}`);
        incompatible.close();

        const rebuilt = await runEffect(
          ensureVectorIndex({agentContextHome: home}, manifest, candidates).pipe(
            provideTestLayer(runtimeLayer),
            provideTestLayer(modelStoreLayer),
          ),
        );

        expect(rebuilt.ready).toBe(true);
        expect(rebuilt.embeddedChunkCount).toBe(1);
        const current = new Database(vectorDatabasePath(home), {readonly: true});
        try {
          expect(current.query('PRAGMA user_version').get()).toEqual({user_version: 5});
        } finally {
          current.close();
        }
      } finally {
        await rm(home, {force: true, recursive: true});
      }
    },
  );

  it.each([0, 2])('recreates a structurally malformed schema at user_version %i', async userVersion => {
    const home = await mkdtemp(`threadnote-vector-malformed-v${userVersion}-`);
    const candidates = [{text: '# Alpha\n\nSchema recovery.', uri: 'threadnote://resources/repos/a.md'}];
    try {
      await mkdir(join(vectorDatabasePath(home), '..'), {recursive: true});
      const malformed = new Database(vectorDatabasePath(home));
      malformed.exec(`CREATE TABLE vector_values (broken TEXT); PRAGMA user_version = ${userVersion}`);
      malformed.close();

      const rebuilt = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, candidates).pipe(
          provideTestLayer(fakeRuntimeLayer(() => 0)),
          provideTestLayer(modelStoreLayer),
        ),
      );

      expect(rebuilt).toMatchObject({chunkCount: 1, embeddedChunkCount: 1, ready: true});
      const current = new Database(vectorDatabasePath(home), {readonly: true});
      try {
        expect(current.query("PRAGMA table_info('vector_values')").all()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({name: 'id'}),
            expect.objectContaining({name: 'vector_key'}),
            expect.objectContaining({name: 'vector'}),
          ]),
        );
      } finally {
        current.close();
      }
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('recovers a malformed vector database without risking canonical resources', async () => {
    const home = await mkdtemp('threadnote-vector-database-recovery-');
    const candidates = [{text: '# Alpha\n\nDatabase recovery.', uri: 'threadnote://resources/repos/a.md'}];
    try {
      const runtimeLayer = fakeRuntimeLayer(() => 0);
      await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, candidates).pipe(
          provideTestLayer(runtimeLayer),
          provideTestLayer(modelStoreLayer),
        ),
      );
      await rm(vectorDatabasePath(home), {force: true});
      await rm(`${vectorDatabasePath(home)}-shm`, {force: true});
      await rm(`${vectorDatabasePath(home)}-wal`, {force: true});
      await writeFile(vectorDatabasePath(home), 'not a sqlite database', 'utf8');

      const rebuilt = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, candidates).pipe(
          provideTestLayer(runtimeLayer),
          provideTestLayer(modelStoreLayer),
        ),
      );

      expect(rebuilt).toMatchObject({chunkCount: 1, embeddedChunkCount: 1, ready: true});
      await expect(runEffect(vectorIndexStatus(home, manifest))).resolves.toMatchObject({
        chunkCount: 1,
        ready: true,
      });
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('reports corrupt vector rows and repairs only the affected chunk on rebuild', async () => {
    const home = await mkdtemp('threadnote-vector-row-recovery-');
    const candidates = [
      {text: '# Alpha\n\nStable canonical content.', uri: 'threadnote://resources/repos/a.md'},
      {text: '# Beta\n\nRepair this vector row.', uri: 'threadnote://resources/repos/b.md'},
    ];
    try {
      const runtimeLayer = fakeRuntimeLayer(input =>
        Effect2.pipe(input, EffectString.toLowerCase, EffectString.includes('alpha')) ? 0 : 1,
      );
      await runEffect(
        Effect.gen(function* () {
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          yield* rebuildVectorIndex({agentContextHome: home}, manifest, candidates);
        }).pipe(provideTestLayer(runtimeLayer), provideTestLayer(modelStoreLayer)),
      );
      const corrupted = new Database(vectorDatabasePath(home));
      corrupted.exec(`
        UPDATE vector_values
        SET vector = zeroblob(4)
        WHERE id = (SELECT vector_id FROM vector_chunks ORDER BY chunk_id LIMIT 1)
      `);
      corrupted.close();

      const status = await runEffect(vectorIndexStatus(home, manifest));
      const failedSearch = await runEffect(
        selectedSemanticScores({agentContextHome: home}, 'alpha').pipe(
          provideTestLayer(runtimeLayer),
          provideTestLayer(modelStoreLayer),
          Effect.as('unexpected'),
          Effect.catchCause(() => Effect.succeed('failed')),
        ),
      );
      const repaired = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, candidates).pipe(
          provideTestLayer(runtimeLayer),
          provideTestLayer(modelStoreLayer),
        ),
      );

      expect(status.ready).toBe(false);
      expect(status.reason).toContain('corrupt');
      expect(failedSearch).toBe('failed');
      expect(repaired).toMatchObject({chunkCount: 2, embeddedChunkCount: 1, ready: true, reusedChunkCount: 1});
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('repairs a corrupt active vector once during semantic recall and returns semantic scores', async () => {
    const home = await mkdtemp('threadnote-vector-semantic-repair-');
    const config = {account: 'local', agentContextHome: home, user: 'me'};
    const uri = 'threadnote://resources/repos/threadnote/alpha.md';
    const resourcePath = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'alpha.md');
    const embeddedBatches: number[] = [];
    const runtimeLayer = fakeRuntimeLayer(
      () => 0,
      inputs => embeddedBatches.push(inputs.length),
    );
    try {
      await mkdir(join(resourcePath, '..'), {recursive: true});
      await writeFile(resourcePath, '# Alpha\n\nSemantic repair content.', 'utf8');
      await runEffect(
        Effect.gen(function* () {
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          const index = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
          yield* rebuildVectorIndex(config, manifest, index.candidates, {corpusGeneration: index.generation});
        }).pipe(provideTestLayer(runtimeLayer), provideTestLayer(modelStoreLayer)),
      );
      const corrupted = new Database(vectorDatabasePath(home));
      corrupted.exec('UPDATE vector_values SET vector = zeroblob(4)');
      corrupted.close();

      const scores = await runEffect(
        loadRecallSemanticScores(config, 'alpha semantic repair', 5).pipe(
          provideTestLayer(runtimeLayer),
          provideTestLayer(modelStoreLayer),
        ),
      );

      expect(scores?.get(uri)).toBeCloseTo(1);
      expect(embeddedBatches).toEqual([1, 1, 1, 1]);
      const repaired = new Database(vectorDatabasePath(home), {readonly: true});
      try {
        expect(repaired.query('SELECT length(vector) AS bytes FROM vector_values').get()).toEqual({
          bytes: manifest.dimensions * 4,
        });
      } finally {
        repaired.close();
      }
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('keeps MCP semantic retrieval read-only when the active vector is corrupt', async () => {
    const home = await mkdtemp('threadnote-vector-mcp-read-only-');
    const config = {account: 'local', agentContextHome: home, user: 'me'};
    const resourcePath = join(home, 'data', 'local', 'resources', 'repos', 'threadnote', 'alpha.md');
    const embeddedBatches: number[] = [];
    const runtimeLayer = fakeRuntimeLayer(
      () => 0,
      inputs => embeddedBatches.push(inputs.length),
    );
    try {
      await mkdir(join(resourcePath, '..'), {recursive: true});
      await writeFile(resourcePath, '# Alpha\n\nRead-only semantic fallback content.', 'utf8');
      await runEffect(
        Effect.gen(function* () {
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          const index = yield* loadRecallIndexData(config, {forceRefresh: true, includeInactive: false});
          yield* rebuildVectorIndex(config, manifest, index.candidates, {corpusGeneration: index.generation});
        }).pipe(provideTestLayer(runtimeLayer), provideTestLayer(modelStoreLayer)),
      );
      const corrupted = new Database(vectorDatabasePath(home));
      corrupted.exec('UPDATE vector_values SET vector = zeroblob(4)');
      corrupted.close();

      const result = await runEffect(
        loadMcpRecallSemanticScoresResult(config, 'alpha read-only fallback', 5).pipe(
          provideTestLayer(runtimeLayer),
          provideTestLayer(modelStoreLayer),
        ),
      );

      expect(result.status).toBe('failed');
      expect(Option.getOrUndefined(result.result.warning)).toContain('deterministic lexical recall continued');
      expect(embeddedBatches).toEqual([1, 1]);
      const unchanged = new Database(vectorDatabasePath(home), {readonly: true});
      try {
        expect(unchanged.query('SELECT length(vector) AS bytes FROM vector_values').get()).toEqual({bytes: 4});
      } finally {
        unchanged.close();
      }
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('keeps the active generation when a replacement embedding run is interrupted', async () => {
    const home = await mkdtemp('threadnote-vector-interrupt-');
    try {
      const candidates = [{text: '# Alpha\n\nStable canonical content.', uri: 'threadnote://resources/repos/a.md'}];
      const first = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, candidates).pipe(
          provideTestLayer(fakeRuntimeLayer(() => 0)),
          provideTestLayer(modelStoreLayer),
        ),
      );
      const failed = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, [
          {text: '# Alpha\n\nChanged canonical content.', uri: 'threadnote://resources/repos/a.md'},
        ]).pipe(
          provideTestLayer(
            Layer.succeed(
              LocalModelRuntime,
              LocalModelRuntime.of({
                diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
                embedMany: () =>
                  Effect.fail(
                    InferenceInterrupted.make({
                      message: 'fixture interruption',
                      modelId: manifest.id,
                      operation: 'embed',
                    }),
                  ),
                generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
                rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
              }),
            ),
          ),
          provideTestLayer(modelStoreLayer),
          Effect.result,
        ),
      );
      const status = await runEffect(vectorIndexStatus(home, manifest));
      expect(Result.isFailure(failed)).toBe(true);
      expect(status.ready).toBe(true);
      expect(status.generation).toBe(first.generation);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('reuses unchanged chunks and embeds only changed canonical content', async () => {
    const home = await mkdtemp('threadnote-vector-incremental-');
    try {
      const embeddedInputs: string[][] = [];
      const runtimeLayer = fakeRuntimeLayer(
        input => (Effect2.pipe(input, EffectString.toLowerCase, EffectString.includes('alpha')) ? 0 : 1),
        inputs => embeddedInputs.push([...inputs]),
      );
      const candidates = [
        {text: '# Alpha\n\nStable canonical content.', uri: 'threadnote://resources/repos/a.md'},
        {text: '# Beta\n\nOriginal canonical content.', uri: 'threadnote://resources/repos/b.md'},
      ];
      const rebuild = (documents: typeof candidates) =>
        runEffect(
          rebuildVectorIndex({agentContextHome: home}, manifest, documents).pipe(
            provideTestLayer(runtimeLayer),
            provideTestLayer(modelStoreLayer),
          ),
        );

      const first = await rebuild(candidates);
      const unchanged = await rebuild(candidates);
      const beforeChange = new Database(vectorDatabasePath(home), {readonly: true});
      const stableVectorId = requiredRow(
        beforeChange
          .query<{readonly vector_id: number}, SQLQueryBindings[]>(
            `SELECT vector_id
             FROM vector_chunks
             WHERE uri = 'threadnote://resources/repos/a.md'`,
          )
          .get(),
      ).vector_id;
      beforeChange.close();
      const changed = await rebuild([
        candidates[0],
        {text: '# Beta\n\nChanged canonical content.', uri: 'threadnote://resources/repos/b.md'},
      ]);

      expect(first.embeddedChunkCount).toBe(2);
      expect(first.reusedChunkCount).toBe(0);
      expect(unchanged.embeddedChunkCount).toBe(0);
      expect(unchanged.reusedChunkCount).toBe(2);
      expect(changed.embeddedChunkCount).toBe(1);
      expect(changed.reusedChunkCount).toBe(1);
      expect(EffectArray.map(embeddedInputs, inputs => inputs.length)).toEqual([2, 1]);
      const database = new Database(vectorDatabasePath(home), {readonly: true});
      try {
        expect(database.query('SELECT COUNT(*) AS count FROM vector_values').get()).toEqual({count: 2});
        expect(database.query('SELECT COUNT(*) AS count FROM vector_chunks').get()).toEqual({count: 2});
        expect(database.query('SELECT COUNT(*) AS count FROM vector_generations').get()).toEqual({count: 1});
        expect(
          database
            .query(
              `SELECT vector_id
               FROM vector_chunks
               WHERE uri = 'threadnote://resources/repos/a.md'`,
            )
            .get(),
        ).toEqual({vector_id: stableVectorId});
      } finally {
        database.close();
      }
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('automatically refreshes a stale vector generation and leaves a current one untouched', async () => {
    const home = await mkdtemp('threadnote-vector-ensure-');
    try {
      const embeddedInputs: string[][] = [];
      const runtimeLayer = fakeRuntimeLayer(
        input => (Effect2.pipe(input, EffectString.toLowerCase, EffectString.includes('alpha')) ? 0 : 1),
        inputs => embeddedInputs.push([...inputs]),
      );
      const initial = [
        {text: '# Alpha\n\nStable canonical content.', uri: 'threadnote://resources/repos/a.md'},
        {text: '# Beta\n\nOriginal canonical content.', uri: 'threadnote://resources/repos/b.md'},
      ];
      const ensure = (documents: typeof initial, corpusGeneration: string) =>
        runEffect(
          ensureVectorIndex({agentContextHome: home}, manifest, documents, {corpusGeneration}).pipe(
            provideTestLayer(runtimeLayer),
            provideTestLayer(modelStoreLayer),
          ),
        );

      const first = await ensure(initial, 'lexical-generation-1');
      const current = await ensure(initial, 'lexical-generation-1');
      const metadataOnlyRefresh = await ensure(initial, 'lexical-generation-2');
      const metadataOnlyRefreshIsCurrent = await runEffect(
        vectorIndexMatchesGeneration(home, manifest, 'lexical-generation-2'),
      );
      const changedDocuments = [
        initial[0],
        {text: '# Beta\n\nChanged canonical content.', uri: 'threadnote://resources/repos/b.md'},
      ];
      const refreshed = await ensure(changedDocuments, 'lexical-generation-3');
      const status = await runEffect(vectorIndexStatus(home, manifest, changedDocuments));

      expect(first.embeddedChunkCount).toBe(2);
      expect(current.embeddedChunkCount).toBe(0);
      expect(current.reusedChunkCount).toBe(2);
      expect(metadataOnlyRefresh.embeddedChunkCount).toBe(0);
      expect(metadataOnlyRefresh.reusedChunkCount).toBe(2);
      expect(metadataOnlyRefreshIsCurrent).toBe(true);
      expect(refreshed.embeddedChunkCount).toBe(1);
      expect(refreshed.reusedChunkCount).toBe(1);
      expect(EffectArray.map(embeddedInputs, inputs => inputs.length)).toEqual([2, 1]);
      expect(status.ready).toBe(true);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('rejects an older corpus waiter after a newer generation wins the vector lock', async () => {
    const home = await mkdtemp('threadnote-vector-generation-fence-');
    let releaseEmbedding!: () => void;
    let reportEmbeddingStarted!: () => void;
    const embeddingStarted = new Promise<void>(resolve => {
      reportEmbeddingStarted = resolve;
    });
    let embeddingCalls = 0;
    const currentGeneration = 'lexical-generation-2';
    const generationFence = () => Effect.succeedSome(currentGeneration);
    const runtimeLayer = Layer.succeed(
      LocalModelRuntime,
      LocalModelRuntime.of({
        diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
        embedMany: ({inputs, manifest: requested}) => {
          embeddingCalls += 1;
          return Effect.promise(
            () =>
              new Promise<readonly (readonly number[])[]>(resolve => {
                reportEmbeddingStarted();
                releaseEmbedding = () =>
                  resolve(EffectArray.map(inputs, () => unitVector(requested.dimensions ?? 0, 0)));
              }),
          );
        },
        generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
        rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
      }),
    );
    const ensure = (corpusGeneration: string, text: string) =>
      runEffect(
        ensureVectorIndex(
          {agentContextHome: home},
          manifest,
          [{text, uri: 'threadnote://resources/repos/generation.md'}],
          {corpusGeneration, currentCorpusGeneration: generationFence},
        ).pipe(provideTestLayer(runtimeLayer), provideTestLayer(modelStoreLayer)),
      );

    try {
      const newer = ensure(currentGeneration, '# Current\n\nNewest corpus content.');
      await embeddingStarted;
      const older = runEffect(
        ensureVectorIndex(
          {agentContextHome: home},
          manifest,
          [{text: '# Stale\n\nOlder corpus content.', uri: 'threadnote://resources/repos/generation.md'}],
          {
            corpusGeneration: 'lexical-generation-1',
            currentCorpusGeneration: generationFence,
          },
        ).pipe(provideTestLayer(runtimeLayer), provideTestLayer(modelStoreLayer), Effect.result),
      );

      releaseEmbedding();
      await expect(newer).resolves.toMatchObject({ready: true});
      const olderResult = await older;
      expect(Result.isFailure(olderResult)).toBe(true);
      if (Result.isFailure(olderResult)) {
        expect(olderResult.failure).toBeInstanceOf(VectorCorpusGenerationChanged);
      }
      expect(embeddingCalls).toBe(1);
      expect(await runEffect(vectorIndexMatchesGeneration(home, manifest, currentGeneration))).toBe(true);
      expect(await runEffect(vectorIndexMatchesGeneration(home, manifest, 'lexical-generation-1'))).toBe(false);
    } finally {
      releaseEmbedding?.();
      await rm(home, {force: true, recursive: true});
    }
  });

  it('aborts a stale lock owner before admitting the queued current generation', async () => {
    const home = await mkdtemp('threadnote-vector-stale-owner-fence-');
    let currentGeneration = 'lexical-generation-1';
    let releaseFirstEmbedding!: () => void;
    let reportFirstEmbeddingStarted!: () => void;
    const firstEmbeddingStarted = new Promise<void>(resolve => {
      reportFirstEmbeddingStarted = resolve;
    });
    let embeddingCalls = 0;
    const generationFence = () => Effect.succeedSome(currentGeneration);
    const runtimeLayer = Layer.succeed(
      LocalModelRuntime,
      LocalModelRuntime.of({
        diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
        embedMany: ({inputs, manifest: requested}) => {
          embeddingCalls += 1;
          const vectors = EffectArray.map(inputs, () => unitVector(requested.dimensions ?? 0, 0));
          if (embeddingCalls !== 1) return Effect.succeed(vectors);
          return Effect.promise(
            () =>
              new Promise<readonly (readonly number[])[]>(resolve => {
                reportFirstEmbeddingStarted();
                releaseFirstEmbedding = () => resolve(vectors);
              }),
          );
        },
        generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
        rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
      }),
    );
    const documents = [
      {text: '# Stable\n\nIdentical canonical content.', uri: 'threadnote://resources/repos/generation.md'},
    ];
    const ensure = (corpusGeneration: string) =>
      runEffect(
        ensureVectorIndex({agentContextHome: home}, manifest, documents, {
          corpusGeneration,
          currentCorpusGeneration: generationFence,
        }).pipe(provideTestLayer(runtimeLayer), provideTestLayer(modelStoreLayer), Effect.result),
      );

    try {
      const stale = ensure(currentGeneration);
      await firstEmbeddingStarted;
      currentGeneration = 'lexical-generation-2';
      const current = ensure(currentGeneration);
      releaseFirstEmbedding();

      const [staleResult, currentResult] = await Promise.all([stale, current]);
      expect(Result.isFailure(staleResult)).toBe(true);
      if (Result.isFailure(staleResult)) {
        expect(staleResult.failure).toBeInstanceOf(VectorCorpusGenerationChanged);
      }
      expect(Result.isSuccess(currentResult)).toBe(true);
      expect(embeddingCalls).toBe(2);
      expect(await runEffect(vectorIndexMatchesGeneration(home, manifest, currentGeneration))).toBe(true);
      const database = new Database(vectorDatabasePath(home), {readonly: true});
      try {
        expect(database.query('SELECT corpus_generation, state FROM vector_generations').all()).toEqual([
          {corpus_generation: currentGeneration, state: 'ready'},
        ]);
      } finally {
        database.close();
      }
    } finally {
      releaseFirstEmbedding?.();
      await rm(home, {force: true, recursive: true});
    }
  });

  it('rolls back its own pointer when the lexical generation advances after vector activation', async () => {
    const home = await mkdtemp('threadnote-vector-post-activation-fence-');
    let currentGeneration = 'lexical-generation-1';
    let advanceDuringActivation = true;
    let fenceChecks = 0;
    const generationFence = () =>
      Effect.sync(() => {
        fenceChecks += 1;
        if (advanceDuringActivation && vectorPointerIsExternallyVisible(home)) {
          currentGeneration = 'lexical-generation-2';
        }
        return Option.some(currentGeneration);
      });
    const runtimeLayer = fakeRuntimeLayer(() => 0);
    const documents = [
      {text: '# Stable\n\nIdentical canonical content.', uri: 'threadnote://resources/repos/generation.md'},
    ];
    const ensure = (corpusGeneration: string) =>
      runEffect(
        ensureVectorIndex({agentContextHome: home}, manifest, documents, {
          corpusGeneration,
          currentCorpusGeneration: generationFence,
        }).pipe(provideTestLayer(runtimeLayer), provideTestLayer(modelStoreLayer), Effect.result),
      );

    try {
      const staleResult = await ensure('lexical-generation-1');
      expect(Result.isFailure(staleResult)).toBe(true);
      if (Result.isFailure(staleResult)) {
        expect(staleResult.failure).toBeInstanceOf(VectorCorpusGenerationChanged);
      }
      expect(fenceChecks).toBeGreaterThan(0);
      const rolledBack = new Database(vectorDatabasePath(home), {readonly: true});
      try {
        expect(rolledBack.query('SELECT COUNT(*) AS count FROM vector_pointer').get()).toEqual({count: 0});
        expect(rolledBack.query('SELECT corpus_generation, state FROM vector_generations').all()).toEqual([
          {corpus_generation: 'lexical-generation-1', state: 'building'},
        ]);
      } finally {
        rolledBack.close();
      }

      advanceDuringActivation = false;
      fenceChecks = 0;
      const currentResult = await ensure(currentGeneration);
      expect(Result.isSuccess(currentResult)).toBe(true);
      expect(await runEffect(vectorIndexMatchesGeneration(home, manifest, currentGeneration))).toBe(true);
      const recovered = new Database(vectorDatabasePath(home), {readonly: true});
      try {
        expect(recovered.query('SELECT corpus_generation, state FROM vector_generations').all()).toEqual([
          {corpus_generation: currentGeneration, state: 'ready'},
        ]);
      } finally {
        recovered.close();
      }
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('rejects semantic scores when the vector generation changes during query inference', async () => {
    const home = await mkdtemp('threadnote-vector-score-generation-fence-');
    let currentGeneration = 'lexical-generation-1';
    let delayQuery = false;
    let releaseQuery!: () => void;
    let reportQueryStarted!: () => void;
    const queryStarted = new Promise<void>(resolve => {
      reportQueryStarted = resolve;
    });
    const generationFence = () => Effect.succeedSome(currentGeneration);
    const runtimeLayer = Layer.succeed(
      LocalModelRuntime,
      LocalModelRuntime.of({
        diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
        embedMany: ({inputs, manifest: requested}) => {
          const vectors = EffectArray.map(inputs, () => unitVector(requested.dimensions ?? 0, 0));
          if (
            !delayQuery ||
            !EffectArray.some(inputs, input => Effect2.pipe(input, EffectString.includes('generation-race-query')))
          ) {
            return Effect.succeed(vectors);
          }
          return Effect.promise(
            () =>
              new Promise<readonly (readonly number[])[]>(resolve => {
                reportQueryStarted();
                releaseQuery = () => resolve(vectors);
              }),
          );
        },
        generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
        rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
      }),
    );
    const withRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(provideTestLayer(runtimeLayer), provideTestLayer(modelStoreLayer));

    try {
      const prepared = withRuntime(
        Effect.gen(function* () {
          const catalog = yield* LocalModelCatalog;
          yield* selectLocalModel(home, catalog, 'embedding', manifest.id);
          yield* rebuildVectorIndex(
            {agentContextHome: home},
            manifest,
            [
              {
                text: '# First generation\n\nConsistent semantic content.',
                uri: 'threadnote://resources/repos/generation.md',
              },
            ],
            {corpusGeneration: currentGeneration, currentCorpusGeneration: generationFence},
          );
        }),
      );
      await runEffect(prepared);

      delayQuery = true;
      const scoringProgram = withRuntime(
        selectedSemanticScores({agentContextHome: home}, 'generation-race-query', {
          corpusGeneration: 'lexical-generation-1',
          currentCorpusGeneration: generationFence,
        }).pipe(Effect.result),
      );
      const scoring = runEffect(scoringProgram);
      await queryStarted;
      currentGeneration = 'lexical-generation-2';
      const rebuild = withRuntime(
        rebuildVectorIndex(
          {agentContextHome: home},
          manifest,
          [
            {
              text: '# Second generation\n\nNewer consistent semantic content.',
              uri: 'threadnote://resources/repos/generation.md',
            },
          ],
          {corpusGeneration: currentGeneration, currentCorpusGeneration: generationFence},
        ),
      );
      await runEffect(rebuild);
      releaseQuery();

      const result = await scoring;
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(VectorCorpusGenerationChanged);
      expect(await runEffect(vectorIndexMatchesGeneration(home, manifest, currentGeneration))).toBe(true);
    } finally {
      releaseQuery?.();
      await rm(home, {force: true, recursive: true});
    }
  });

  it('resumes an interrupted rebuild from its checksummed staging checkpoint', async () => {
    const home = await mkdtemp('threadnote-vector-resume-');
    const candidates = Array.from({length: 300}, (_, index) => ({
      text: `# Document ${index}\n\nCanonical content ${index}.`,
      uri: `threadnote://resources/repos/doc-${index}.md`,
    }));
    try {
      let call = 0;
      const interruptedLayer = Layer.succeed(
        LocalModelRuntime,
        LocalModelRuntime.of({
          diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
          embedMany: ({inputs, manifest: requested}) => {
            call += 1;
            if (call === 2) {
              return Effect.fail(
                InferenceInterrupted.make({
                  message: 'fixture interruption',
                  modelId: manifest.id,
                  operation: 'embed',
                }),
              );
            }
            return Effect.succeed(
              EffectArray.map(inputs, (_, index) => unitVector(requested.dimensions ?? 0, index % 2)),
            );
          },
          generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
          rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
        }),
      );
      const interrupted = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, candidates).pipe(
          provideTestLayer(interruptedLayer),
          provideTestLayer(modelStoreLayer),
          Effect.result,
        ),
      );
      expect(Result.isFailure(interrupted)).toBe(true);

      const resumedBatches: number[] = [];
      const resumed = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, candidates).pipe(
          provideTestLayer(
            fakeRuntimeLayer(
              () => 0,
              inputs => resumedBatches.push(inputs.length),
            ),
          ),
          provideTestLayer(modelStoreLayer),
        ),
      );
      expect(resumed.chunkCount).toBe(300);
      expect(resumed.reusedChunkCount).toBe(256);
      expect(resumed.embeddedChunkCount).toBe(44);
      expect(resumedBatches).toEqual([44]);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('reports batch-level embedding and activation progress', async () => {
    const home = await mkdtemp('threadnote-vector-progress-');
    const candidates = Array.from({length: 300}, (_, index) => ({
      text: `# Document ${index}\n\nCanonical content ${index}.`,
      uri: `threadnote://resources/repos/doc-${index}.md`,
    }));
    try {
      const progress: unknown[] = [];
      const rebuilt = await runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, candidates, {
          onProgress: event =>
            Effect.sync(() => {
              progress.push(event);
            }),
        }).pipe(provideTestLayer(fakeRuntimeLayer(() => 0)), provideTestLayer(modelStoreLayer)),
      );

      expect(rebuilt.chunkCount).toBe(300);
      expect(progress).toEqual([
        {completed: 0, phase: 'embedding', reused: 0, total: 300},
        {completed: 256, phase: 'embedding', reused: 0, total: 300},
        {completed: 300, phase: 'embedding', reused: 0, total: 300},
        {chunkCount: 300, phase: 'activating'},
      ]);
    } finally {
      await rm(home, {force: true, recursive: true});
    }
  });

  it('serializes purge behind an in-progress vector rebuild', async () => {
    const home = await mkdtemp('threadnote-vector-purge-lock-');
    let releaseEmbedding!: () => void;
    let embeddingStarted!: () => void;
    const started = new Promise<void>(resolve => {
      embeddingStarted = resolve;
    });
    const runtimeLayer = Layer.succeed(
      LocalModelRuntime,
      LocalModelRuntime.of({
        diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
        embedMany: ({inputs, manifest: requested}) =>
          Effect.promise(
            () =>
              new Promise<readonly (readonly number[])[]>(resolve => {
                embeddingStarted();
                releaseEmbedding = () =>
                  resolve(EffectArray.map(inputs, () => unitVector(requested.dimensions ?? 0, 0)));
              }),
          ),
        generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
        rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
      }),
    );
    try {
      const rebuilding = runEffect(
        rebuildVectorIndex({agentContextHome: home}, manifest, [
          {text: '# Alpha\n\nLock coordination.', uri: 'threadnote://resources/repos/a.md'},
        ]).pipe(provideTestLayer(runtimeLayer), provideTestLayer(modelStoreLayer)),
      );
      await started;
      let purgeSettled = false;
      const purging = runEffect(purgeVectorIndex(home, manifest.id)).finally(() => {
        purgeSettled = true;
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(purgeSettled).toBe(false);

      releaseEmbedding();
      await expect(rebuilding).resolves.toMatchObject({ready: true});
      await expect(purging).resolves.toBe(true);
      await expect(stat(vectorDatabasePath(home))).rejects.toThrow();
    } finally {
      releaseEmbedding?.();
      await rm(home, {force: true, recursive: true});
    }
  });
});

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

function fakeRuntimeLayer(
  vectorIndex: (input: string) => number,
  onInputs: (inputs: readonly string[]) => void = () => undefined,
) {
  return Layer.succeed(
    LocalModelRuntime,
    LocalModelRuntime.of({
      diagnostics: Effect.succeed({backend: 'fake', buildType: 'prebuilt', cpuMathCores: 4}),
      embedMany: ({inputs, manifest: requested}) =>
        Effect.sync(() => {
          onInputs(inputs);
          return EffectArray.map(inputs, input => unitVector(requested.dimensions ?? 0, vectorIndex(input)));
        }),
      generate: () => Effect.die(TestError.make({message: 'Unexpected generation'})),
      rerank: () => Effect.die(TestError.make({message: 'Unexpected reranking'})),
    }),
  );
}

function unitVector(dimensions: number, index: number): readonly number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[index] = 1;
  return vector;
}

function vectorDatabasePath(home: string): string {
  return join(home, 'indexes', 'vectors', manifest.id, vectorIndexDatabaseFilename());
}

function vectorPointerIsExternallyVisible(home: string): boolean {
  let database: Database | undefined;
  try {
    database = new Database(vectorDatabasePath(home), {readonly: true});
    const row = requiredRow(
      database
        .query<{readonly count: number}, SQLQueryBindings[]>('SELECT COUNT(*) AS count FROM vector_pointer')
        .get(),
    );
    return Number(row.count) > 0;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}
