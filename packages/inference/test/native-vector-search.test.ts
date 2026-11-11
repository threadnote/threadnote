import {describe, expect, it as effectIt} from '@effect/vitest';
import {Array as EffectArray, Effect, Fiber, Layer, Path, Ref} from 'effect';
import {NativeVectorSearch, makeNativeVectorSearch} from '../src/native/vector-search.js';
import {offerBoundedBest, searchExactVectorBlobs, type VectorSearchResult} from '../src/vector-search.js';

function bytes(x: number, y: number): Uint8Array {
  const result = new Uint8Array(13).subarray(3, 11);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setFloat32(0, x, true);
  view.setFloat32(4, y, true);
  return result;
}

describe.runIf(process.env.THREADNOTE_NATIVE_VECTOR_EXPERIMENT === '1')(
  'experimental native vector Effect adapter',
  () => {
    effectIt.layer(NativeVectorSearch.experimentalLayer.pipe(Layer.provide(Path.layer)))(layerIt => {
      layerIt.effect('preserves strict recall validation, raw candidate scores and cross-page tie selection', () =>
        Effect.gen(function* () {
          const scorer = yield* NativeVectorSearch;
          const records = Array.from({length: 405}, (_, index) => ({
            id: `${index % 2 ? '\uE000' : '\u{10000}'}-${405 - index}`,
            vector: bytes(index % 3 ? 1 : 1.001, 0),
          }));
          const query = [0.6, 0.8];
          const compare = (left: VectorSearchResult, right: VectorSearchResult) =>
            right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
          const best: VectorSearchResult[] = [];
          for (const page of [records.slice(0, 400), records.slice(400)]) {
            const results = yield* scorer.search(query, page, 2, 25);
            EffectArray.forEach(results, result => offerBoundedBest(best, result, 25, compare));
          }
          expect(best.sort(compare)).toEqual(searchExactVectorBlobs(query, records, {dimensions: 2, limit: 25}));
          const invalid = yield* Effect.result(scorer.search(query, [{id: 'broken', vector: bytes(0, 0)}], 2, 0));
          expect(invalid).toMatchObject({
            _tag: 'Failure',
            failure: {message: 'Stored vector broken is not L2-normalized.'},
          });
          const nonfinite = yield* Effect.result(
            scorer.search(query, [{id: 'bad', vector: bytes(Number.NaN, 0)}], 2, 25),
          );
          expect(nonfinite).toMatchObject({
            _tag: 'Failure',
            failure: {message: 'Stored vector bad contains a non-finite component.'},
          });
        }),
      );
    });

    effectIt.effect('drains an interrupted page before admitting the next request and discards its result', () =>
      Effect.gen(function* () {
        let active = false;
        let first = true;
        let complete: ((value: unknown) => void) | undefined;
        const adapter = makeNativeVectorSearch({
          searchBatch: () => {
            if (active) throw new Error('Page budget released before native completion.');
            if (!first) return Promise.resolve({indices: [0], scores: [1]});
            first = false;
            active = true;
            return new Promise(resolve => {
              complete = value => {
                active = false;
                resolve(value);
              };
            });
          },
        });
        const published = yield* Ref.make(false);
        const fiber = yield* adapter.search([1, 0], [{id: 'a', vector: bytes(1, 0)}], 2, 1).pipe(
          Effect.tap(() => Ref.set(published, true)),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        expect(active).toBe(true);
        const interrupted = yield* Ref.make(false);
        const interruption = yield* Fiber.interrupt(fiber).pipe(
          Effect.tap(() => Ref.set(interrupted, true)),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        expect(yield* Ref.get(interrupted)).toBe(false);
        expect(active).toBe(true);
        complete?.({indices: [0], scores: [1]});
        yield* Fiber.join(interruption);
        expect(yield* adapter.search([1, 0], [{id: 'next', vector: bytes(1, 0)}], 2, 1)).toEqual([
          {id: 'next', score: 1},
        ]);
        expect(yield* Ref.get(published)).toBe(false);
      }),
    );
  },
);
