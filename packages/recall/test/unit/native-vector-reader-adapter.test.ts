import {it as effectIt} from '@effect/vitest';
import {Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Result, Schema, String as EffectString} from 'effect';
import * as BunServices from '@effect/platform-bun/BunServices';
import {SystemInfo} from '@threadnote/platform/system';
import {cryptoLayer} from '@threadnote/platform/crypto';
import {VectorIndexOperationError} from '../../src/vector/scoring.js';
import {ChildEnvironmentPolicy} from '@threadnote/platform/child-environment-policy';
import {RuntimeEntrypoint} from '@threadnote/platform/runtime-entrypoint';
import {
  readSelectedSemanticVectorScores,
  VectorCorpusGenerationChanged,
  vectorIndexDatabaseFilename,
} from '../../src/vector-index.js';
import {recallVectorAuthorizationKey} from '../../src/vector/preparation-identity.js';
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
