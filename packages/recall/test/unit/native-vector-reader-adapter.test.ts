import {it as effectIt} from '@effect/vitest';
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
  String as EffectString,
} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {SystemInfo} from '@threadnote/platform/system';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {VectorIndexOperationError} from '../../src/vector/scoring.js';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import * as SqlClient from 'effect/sql/SqlClient';
import {RECALL_CHUNKER_VERSION} from '../../src/chunker.js';
import {ResourceStore} from '@threadnote/store/resource-store';
import {recallResourceInvalidationLayer} from '@threadnote/recall/resource-invalidation';
import {TestClock} from 'effect/testing';
import * as VectorIndex from '../../src/vector-index.js';
import {loadRecallIndexData} from '../../src/index.js';
import {VECTOR_SCOPE_MAPPING_VERSION} from '../../src/vector/generation-compatibility.js';
import {
  recallVectorStorage,
  VectorCorpusGenerationChanged,
  vectorIndexDatabaseFilename,
} from '../../src/vector-index.js';
import {openSelectedSemanticVectorRead, readSelectedSemanticVectorScores} from '../../src/vector/semantic-read.js';
import {
  recallVectorAuthorizationKey,
  recallVectorPreparationIdentity,
  recallVectorPreparationJobId,
} from '../../src/vector/preparation-identity.js';
import {loadNativeVectorReader} from '../../src/vector/native-reader-payload.js';
import {describe, expect, vi} from 'vitest';
vi.mock('../../src/vector/native-reader-payload.js', () => ({loadNativeVectorReader: vi.fn()}));
import {runNativeVectorRead} from '../../src/vector/native-reader.js';
import {
  nativeVectorWireRequest,
  type NativeVectorReaderBinding,
  type NativeVectorReadRequest,
  type NativeVectorReadResult,
} from '../../src/vector/native-reader-contract.js';

const request: NativeVectorReadRequest = {
  dbPath: '/test/vector.sqlite',
  generation: 'generation',
  model: {id: 'model', sha256: 'hash', dimensions: 1, embeddingRecipe: 'recipe', chunkerVersion: 1},
  expectedPreparationJobId: 'idle-recall-v2:hash',
  preparationIdentitySuffix: '"authorization","model","recipe",1]',
  corpusGeneration: 'corpus',
  limit: 5,
  selection: {sql: '1 = 1', params: []},
  aliasScope: {sql: '1 = 1', params: []},
  aliasEligibility: {sql: '1 = 1', params: []},
};
const absent: NativeVectorReadResult = {status: 'absent', corpusCheckRequired: false};

describe('native vector reader admission and ownership', () => {
  effectIt.effect('copies inputs before queueing and preserves the closed outcome', () =>
    Effect.gen(function* () {
      const query = [1];
      const mutable = {...request, model: {...request.model}};
      let finish: ((result: NativeVectorReadResult) => void) | undefined;
      const started = yield* Deferred.make<void>();
      let owned: NativeVectorReadRequest | undefined;
      let ownedQuery: Float64Array | undefined;
      const binding: NativeVectorReaderBinding = {
        CancellationToken: class {
          cancel() {}
        },
        readSelected: (value, vector) => {
          owned = value;
          ownedQuery = vector;
          const promise = new Promise<NativeVectorReadResult>(resolve => {
            finish = resolve;
          });
          Deferred.doneUnsafe(started, Effect.void);
          return promise;
        },
      };
      const fiber = yield* runNativeVectorRead(binding, mutable, query).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      query[0] = 0;
      mutable.model.dimensions = 2;
      expect(ownedQuery?.[0]).toBe(1);
      expect(owned?.model.dimensions).toBe(1);
      finish!(absent);
      expect(yield* Fiber.join(fiber)).toEqual(absent);
    }),
  );

  effectIt.effect('cancels cooperatively and drains the original task before releasing admission', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const thirdStarted = yield* Deferred.make<void>();
      const pending: ((result: NativeVectorReadResult) => void)[] = [];
      let calls = 0;
      const binding: NativeVectorReaderBinding = {
        CancellationToken: class {
          cancel() {
            Deferred.doneUnsafe(cancelled, Effect.void);
          }
        },
        readSelected: () => {
          calls += 1;
          const promise = new Promise<NativeVectorReadResult>(resolve => {
            pending.push(resolve);
          });
          if (calls === 2) Deferred.doneUnsafe(started, Effect.void);
          if (calls === 3) Deferred.doneUnsafe(thirdStarted, Effect.void);
          return promise;
        },
      };
      const first = yield* runNativeVectorRead(binding, request, [1]).pipe(Effect.forkChild);
      const second = yield* runNativeVectorRead(binding, request, [1]).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const third = yield* runNativeVectorRead(binding, request, [1]).pipe(Effect.forkChild);
      const interruption = yield* Fiber.interrupt(first).pipe(Effect.forkChild);
      yield* Deferred.await(cancelled);
      yield* Effect.yieldNow;
      expect(calls).toBe(2);
      expect(yield* Deferred.isDone(thirdStarted)).toBe(false);
      pending[0](absent);
      yield* Fiber.join(interruption);
      yield* Deferred.await(thirdStarted);
      pending[1](absent);
      pending[2](absent);
      yield* Fiber.join(second);
      yield* Fiber.join(third);
    }),
  );

  effectIt.effect('releases admission after a rejected task so subsequent work can run', () =>
    Effect.gen(function* () {
      let calls = 0;
      const binding: NativeVectorReaderBinding = {
        CancellationToken: class {
          cancel() {}
        },
        readSelected: () => (++calls === 1 ? Promise.reject(new Error('native fault')) : Promise.resolve(absent)),
      };
      const failure = yield* runNativeVectorRead(binding, request, [1]).pipe(Effect.result);
      expect(failure._tag).toBe('Failure');
      expect(yield* runNativeVectorRead(binding, request, [1])).toEqual(absent);
    }),
  );
});

describe('native vector input transport', () => {
  effectIt.effect('keeps lossless expected metadata separate from SQL string binding', () =>
    Effect.sync(() => {
      const value = nativeVectorWireRequest({
        ...request,
        model: {...request.model, id: 'a\ud800\0b'},
        corpusGeneration: '\udfff',
      });
      expect(value.model.idUtf16).toEqual([97, 0xd800, 0, 98]);
      expect(value.corpusGenerationUtf16).toEqual([0xdfff]);
      expect(nativeVectorWireRequest({...request, corpusGeneration: undefined}).corpusGenerationUtf16).toBeUndefined();
    }),
  );
});

const platform = Layer.mergeAll(
  BunServices.layer,
  cryptoLayer,
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
);
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(platform).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))));
const scoreFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'native-adapter-fence-'});
  const model = {id: 'test-model', sha256: EffectString.repeat(64)('a'), dimensions: 1};
  const db = path.join(home, 'indexes', 'vectors', model.id, vectorIndexDatabaseFilename());
  yield* fs.makeDirectory(path.dirname(db), {recursive: true});
  // This deliberately invalid SQLite file makes an accidental semantic-error
  // fallback observable rather than silently satisfying the assertion.
  yield* fs.writeFile(db, new Uint8Array());
  const state = {
    chunkCount: 1,
    generation: '1-abcdef',
    authorizationKey: recallVectorAuthorizationKey({}),
    corpusGeneration: 'corpus',
  };
  return {config: {agentContextHome: home}, model, state};
});

describe('one-shot lexical corpus adaptation', () => {
  effectIt.effect('preserves metadata error precedence and never retries a semantic native failure', () =>
    Effect.gen(function* () {
      const f = yield* scoreFixture;
      for (const corpusCheckRequired of [false, true]) {
        let calls = 0;
        vi.mocked(loadNativeVectorReader).mockResolvedValue({
          CancellationToken: class {
            cancel() {}
          },
          readSelected: () => {
            calls += 1;
            return Promise.resolve({
              status: 'operation-error',
              message: 'native metadata failure',
              corpusCheckRequired,
            });
          },
        });
        const result = yield* readSelectedSemanticVectorScores(
          f.config,
          f.model,
          f.state,
          Option.some([1]),
          {
            corpusGeneration: 'corpus',
            currentCorpusGeneration: () => Effect.succeedSome('superseded'),
          },
          false,
        ).pipe(Effect.result);
        expect(calls).toBe(1);
        expect(
          Result.isFailure(result) &&
            Schema.is(corpusCheckRequired ? VectorCorpusGenerationChanged : VectorIndexOperationError)(result.failure),
        ).toBe(true);
        if (!corpusCheckRequired)
          expect(
            Result.isFailure(result) && Schema.is(VectorIndexOperationError)(result.failure) && result.failure.message,
          ).toBe('native metadata failure');
      }
    }).pipe(provide),
  );

  effectIt.effect('checks the closing lexical corpus even when native returns an absent result', () =>
    Effect.gen(function* () {
      const f = yield* scoreFixture;
      for (const outcome of [
        absent,
        {status: 'success', scores: [], corpusCheckRequired: true},
      ] satisfies NativeVectorReadResult[]) {
        let checks = 0;
        vi.mocked(loadNativeVectorReader).mockResolvedValue({
          CancellationToken: class {
            cancel() {}
          },
          readSelected: () => Promise.resolve(outcome),
        });
        const result = yield* readSelectedSemanticVectorScores(
          f.config,
          f.model,
          f.state,
          Option.some([1]),
          {
            corpusGeneration: 'corpus',
            currentCorpusGeneration: () => Effect.sync(() => Option.some(++checks === 1 ? 'corpus' : 'superseded')),
          },
          false,
        ).pipe(Effect.result);
        expect(checks).toBe(2);
        expect(Result.isFailure(result) && Schema.is(VectorCorpusGenerationChanged)(result.failure)).toBe(true);
      }
    }).pipe(provide),
  );

  effectIt.effect('uses native for direct callers, optional corpus and SQL replacement inputs', () =>
    Effect.gen(function* () {
      const f = yield* scoreFixture;
      const seen: NativeVectorReadRequest[] = [];
      vi.mocked(loadNativeVectorReader).mockResolvedValue({
        CancellationToken: class {
          cancel() {}
        },
        readSelected: request => {
          seen.push(request);
          return Promise.resolve(absent);
        },
      });
      for (const corpusGeneration of [undefined, 'corpus']) {
        expect(
          yield* readSelectedSemanticVectorScores(f.config, f.model, f.state, Option.some([Number.MAX_VALUE]), {
            corpusGeneration,
            allowedUriScopes: ['a\ud800\0b'],
            ...(corpusGeneration === undefined ? {} : {currentCorpusGeneration: () => Effect.succeedSome('corpus')}),
          }),
        ).toBeUndefined();
      }
      expect(seen).toHaveLength(2);
      expect(seen[0].corpusGeneration).toBeUndefined();
      expect(seen[0].selection.params).toContain('a\ud800\0b');
    }).pipe(provide),
  );

  effectIt.effect('reports a missing capability before any selected read', () =>
    Effect.gen(function* () {
      const f = yield* scoreFixture;
      vi.mocked(loadNativeVectorReader).mockRejectedValueOnce(new Error('Required native vector reader is missing.'));
      const result = yield* readSelectedSemanticVectorScores(f.config, f.model, f.state, Option.some([1])).pipe(
        Effect.result,
      );
      expect(
        Result.isFailure(result) && Schema.is(VectorIndexOperationError)(result.failure) && result.failure.message,
      ).toContain('Required native vector reader');
    }).pipe(provide),
  );
});

// A masked state reaches the native reader only with its URI exclusions; no native addon is needed here.
const maskedScoreFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({prefix: 'native-adapter-masked-'});
  const model = {id: 'test-model', sha256: EffectString.repeat(64)('a'), dimensions: 1};
  const authorizationKey = recallVectorAuthorizationKey({});
  const recipe = recallVectorStorage.recipe(model);
  const db = recallVectorStorage.databasePath(path, home, model.id);
  yield* fs.makeDirectory(path.dirname(db), {recursive: true});
  const job = recallVectorPreparationJobId(recallVectorPreparationIdentity('old', authorizationKey, model.id, recipe));
  yield* recallVectorStorage.use(
    db,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* recallVectorStorage.initialize(sql);
      yield* sql`INSERT INTO vector_generations
        (generation, job_id, corpus_generation, model_id, model_sha256, dimensions, embedding_recipe,
         chunker_version, normalized, chunk_count, state, created_at, scope_mapping_version)
        VALUES ('1-abcdef', ${job}, 'old', ${model.id}, ${model.sha256}, 1, ${recipe}, ${RECALL_CHUNKER_VERSION},
         'l2', 0, 'ready', 'now', ${VECTOR_SCOPE_MAPPING_VERSION})`;
      yield* sql`INSERT INTO vector_pointer VALUES (1, '1-abcdef')`;
    }),
  );
  const state = {
    chunkCount: 0,
    generation: '1-abcdef',
    authorizationKey,
    corpusGeneration: 'old',
    mask: {contentGeneration: 'g2', uris: ['u']},
  };
  const setJobId = (authorization: string) =>
    recallVectorStorage.use(
      db,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const other = recallVectorPreparationJobId(
          recallVectorPreparationIdentity('old', authorization, model.id, recipe),
        );
        yield* sql`UPDATE vector_generations SET job_id = ${other}`;
      }),
    );
  return {config: {agentContextHome: home}, model, state, setJobId};
});

const neverNative = () => {
  let calls = 0;
  vi.mocked(loadNativeVectorReader).mockResolvedValue({
    CancellationToken: class {
      cancel() {}
    },
    readSelected: () => {
      calls += 1;
      return Promise.resolve(absent);
    },
  });
  return () => calls;
};

describe('masked native vector request', () => {
  effectIt.effect('rechecks masked compatibility with the current key before any native read', () =>
    Effect.gen(function* () {
      const f = yield* maskedScoreFixture;
      const calls = neverNative();
      // The active identity now binds another authorization key; the caller's masked state must not serve it.
      yield* f.setJobId(EffectString.repeat(64)('f'));
      expect(
        yield* readSelectedSemanticVectorScores(f.config, f.model, f.state, Option.some([1]), {
          corpusGeneration: 'g2',
          currentCorpusGeneration: () => Effect.succeedSome('g2'),
        }),
      ).toBeUndefined();
      expect(calls()).toBe(0);
    }).pipe(provide),
  );

  effectIt.effect('refuses a masked state for another lexical generation before any read', () =>
    Effect.gen(function* () {
      const f = yield* maskedScoreFixture;
      const calls = neverNative();
      const result = yield* readSelectedSemanticVectorScores(f.config, f.model, f.state, Option.some([1]), {
        corpusGeneration: 'g1',
      }).pipe(Effect.result);
      expect(Result.isFailure(result) && Schema.is(VectorCorpusGenerationChanged)(result.failure)).toBe(true);
      expect(calls()).toBe(0);
    }).pipe(provide),
  );

  effectIt.effect('excludes masked URIs in the chunk selection and the alias scope', () =>
    Effect.gen(function* () {
      const f = yield* maskedScoreFixture;
      const seen: NativeVectorReadRequest[] = [];
      vi.mocked(loadNativeVectorReader).mockResolvedValue({
        CancellationToken: class {
          cancel() {}
        },
        readSelected: request => {
          seen.push(request);
          return Promise.resolve(absent);
        },
      });
      expect(
        yield* readSelectedSemanticVectorScores(f.config, f.model, f.state, Option.some([1]), {
          corpusGeneration: 'g2',
          currentCorpusGeneration: () => Effect.succeedSome('g2'),
        }),
      ).toBeUndefined();
      expect(seen).toHaveLength(1);
      const [sent] = seen;
      if (sent === undefined) return yield* Effect.die('Expected one native request.');
      // The native reader checks the served generation's own corpus, never the mask generation.
      expect(sent.corpusGeneration).toBe('old');
      expect(EffectString.endsWith('AND chunk.uri NOT IN (?)')(sent.selection.sql)).toBe(true);
      expect(EffectString.includes('alias.uri NOT IN (?)')(sent.aliasScope.sql)).toBe(true);
      expect(sent.selection.params.at(-1)).toBe('u');
      expect(sent.aliasScope.params.at(-1)).toBe('u');
    }).pipe(provide),
  );
});

// A real older generation: built for one lexical publication, opened after the next one.
const servableOlderFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* ResourceStore;
  const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({prefix: 'native-adapter-older-'}));
  const config = {account: 'local', user: 'me', agentContextHome: home, manifestPath: path.join(home, 'm.json')};
  yield* fs.writeFileString(config.manifestPath, JSON.stringify({version: 1, projects: []}));
  const uri = (name: string) => `threadnote://user/me/memories/durable/${name}.md`;
  const write = (name: string, body: string) =>
    store.mutateChecked(
      {account: config.account, user: config.user, home},
      [
        {
          type: 'write',
          uri: uri(name),
          content: `MEMORY\nkind: durable\nstatus: active\nmemory_id: tn_${name}\nsource_agent_client: test\ntimestamp: 2026-11-03T00:00:00.000Z\n\n${body}`,
          options: {mode: 'upsert'},
        },
      ],
      Effect.void,
    );
  const publish = loadRecallIndexData(config, {includeInactive: false, memoryIds: []}).pipe(
    Effect.map(data => data.generation),
  );
  yield* write('keep', 'alpha keep body');
  yield* write('edit', 'alpha edit body');
  const served = yield* publish;
  const model = {id: 'test-model', sha256: EffectString.repeat(64)('a'), dimensions: 1};
  const recipe = recallVectorStorage.recipe(model);
  const db = recallVectorStorage.databasePath(path, home, model.id);
  yield* fs.makeDirectory(path.dirname(db), {recursive: true});
  const job = recallVectorPreparationJobId(
    recallVectorPreparationIdentity(served, recallVectorAuthorizationKey({}), model.id, recipe),
  );
  yield* recallVectorStorage.use(
    db,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* recallVectorStorage.initialize(sql);
      yield* sql`INSERT INTO vector_generations
        (generation, job_id, corpus_generation, model_id, model_sha256, dimensions, embedding_recipe,
         chunker_version, normalized, chunk_count, state, created_at, scope_mapping_version)
        VALUES ('1-abcdef', ${job}, ${served}, ${model.id}, ${model.sha256}, 1, ${recipe}, ${RECALL_CHUNKER_VERSION},
         'l2', 0, 'ready', 'now', ${VECTOR_SCOPE_MAPPING_VERSION})`;
      yield* sql`INSERT INTO vector_pointer VALUES (1, '1-abcdef')`;
    }),
  );
  yield* write('edit', 'alpha edit body, revised');
  return {config, model, current: yield* publish, editUri: uri('edit')};
});
const provideLexical = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Layer.build(
      ResourceStore.layer.pipe(Layer.provideMerge(Layer.merge(platform, recallResourceInvalidationLayer))),
    ).pipe(Effect.flatMap(context => effect.pipe(Effect.provide(context)))),
  ).pipe(TestClock.withLive);

/**
 * Opens the older generation with the state read's active-row read replaced by `second`. The external-access
 * loader cannot fail with a typed error (its error channel is `never`), so the typed seam is the row read.
 */
const openWithSecondLoad = (
  f: Effect.Success<typeof servableOlderFixture>,
  second: ReturnType<typeof VectorIndex.readActiveVectorGeneration>,
) => {
  const original = VectorIndex.readActiveVectorGeneration;
  let loads = 0;
  return Effect.acquireUseRelease(
    Effect.sync(() =>
      // The readiness check reads the row first; the state read's row read is the second call.
      vi
        .spyOn(VectorIndex, 'readActiveVectorGeneration')
        .mockImplementation((home, manifest) => (++loads === 1 ? original(home, manifest) : second)),
    ),
    () => openSelectedSemanticVectorRead(f.config, f.model, {corpusGeneration: f.current}).pipe(Effect.exit),
    spy => Effect.sync(() => spy.mockRestore()),
  ).pipe(Effect.tap(() => Effect.sync(() => expect(loads).toBe(2))));
};

describe('masked opening failure rule', () => {
  effectIt.effect('serves the older generation, and a typed state-read failure opens it as stale', () =>
    Effect.gen(function* () {
      const f = yield* servableOlderFixture;
      const baseline = yield* openSelectedSemanticVectorRead(f.config, f.model, {corpusGeneration: f.current});
      expect(baseline).toMatchObject({
        readiness: 'serving-older',
        state: {mask: {contentGeneration: f.current, uris: [f.editUri]}},
      });
      const typed: ReturnType<typeof VectorIndex.readActiveVectorGeneration> = Effect.fail(
        VectorIndexOperationError.make({message: 'The vector database is busy.'}),
      );
      const exit = yield* openWithSecondLoad(f, typed);
      expect(Exit.isSuccess(exit) && exit.value).toEqual({readiness: 'stale', corpusGeneration: f.current});
    }).pipe(provideLexical),
  );

  effectIt.effect('propagates a defect in the state read instead of opening as stale', () =>
    Effect.gen(function* () {
      const f = yield* servableOlderFixture;
      const exit = yield* openWithSecondLoad(f, Effect.die('programming error'));
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }).pipe(provideLexical),
  );
});
