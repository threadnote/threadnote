import {Array as EffectArray, Config, Context, Effect, Layer, Option, Path, Schema} from 'effect';
import type {VectorBlobRecord, VectorSearchResult} from '../vector-search.js';
import {offerBoundedBest} from '../vector-search.js';

export class NativeVectorSearchError extends Schema.TaggedError<
  NativeVectorSearchError,
  {readonly brand: unique symbol}
>()('NativeVectorSearchError', {
  message: Schema.String,
}) {}

interface NativeBinding {
  searchBatch(
    protocol: number,
    rows: Uint8Array,
    query: Float64Array,
    ranks: Uint32Array,
    limit: number,
    threshold: number,
    validateUnit: boolean,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

const bindingSchema = Schema.declare<NativeBinding>(
  (value): value is NativeBinding =>
    typeof value === 'object' && value !== null && 'searchBatch' in value && typeof value.searchBatch === 'function',
);
const resultSchema = Schema.Struct({indices: Schema.Array(Schema.Finite), scores: Schema.Array(Schema.Finite)});

export interface NativeVectorSearchShape {
  readonly search: (
    query: readonly number[],
    records: readonly VectorBlobRecord[],
    dimensions: number,
    limit: number,
  ) => Effect.Effect<readonly VectorSearchResult[], NativeVectorSearchError>;
}

/** Experimental capability; absent from normal product layers. */
export class NativeVectorSearch extends Context.Service<NativeVectorSearch, NativeVectorSearchShape>()(
  '@threadnote/inference/native/vector-search/NativeVectorSearch',
) {
  static readonly experimentalLayer = Layer.effect(
    NativeVectorSearch,
    Effect.suspend(() => loadNativeVectorSearch),
  );
}

let cachedNativeVectorSearch: NativeVectorSearchShape | undefined;
export const loadNativeVectorSearch = Effect.suspend(() =>
  cachedNativeVectorSearch === undefined
    ? Effect.gen(function* () {
        const path = yield* Path.Path;
        const library = yield* path.fromFileUrl(new URL('../../native-vector/vector-search.node', import.meta.url));
        const loaded = yield* Effect.try({
          try: () => {
            const nativeModule = {exports: {}};
            process.dlopen(nativeModule, library);
            return nativeModule.exports;
          },
          catch: cause =>
            NativeVectorSearchError.make({message: `Native vector capability unavailable: ${String(cause)}`}),
        });
        const scorer = makeNativeVectorSearch(yield* Schema.decodeUnknownEffect(bindingSchema)(loaded));
        cachedNativeVectorSearch = scorer;
        return scorer;
      }).pipe(Effect.mapError(cause => NativeVectorSearchError.make({message: String(cause)})))
    : Effect.succeed(cachedNativeVectorSearch),
);

export const experimentalNativeVectorSearch = Effect.gen(function* () {
  const selected = yield* Config.Literals(['0', '1'], 'THREADNOTE_NATIVE_VECTOR_EXPERIMENT').pipe(
    Config.withDefault('0'),
  );
  return selected === '1' ? Option.some(yield* loadNativeVectorSearch) : Option.none<NativeVectorSearchShape>();
});

interface NativePageMatch extends VectorSearchResult {
  readonly uri: string;
}
export function mergeNativeVectorPage(
  scorer: NativeVectorSearchShape,
  query: readonly number[],
  records: readonly (VectorBlobRecord & {readonly uri: string})[],
  dimensions: number,
  limit: number,
  best: NativePageMatch[],
) {
  return scorer.search(query, records, dimensions, limit).pipe(
    Effect.map(results => {
      const rowsById = new Map(EffectArray.map(records, row => [row.id, row] as const));
      for (const result of results)
        offerBoundedBest(
          best,
          {...result, uri: rowsById.get(result.id)!.uri},
          limit,
          (left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        );
      return best;
    }),
  );
}

export function makeNativeVectorSearch(binding: NativeBinding): NativeVectorSearchShape {
  return {
    search: (query, records, dimensions, limit) =>
      Effect.acquireUseRelease(
        Effect.sync(() => ({
          pending: (async () => {
            if (query.length !== dimensions)
              throw new Error(`Query vector has ${query.length} dimensions; expected ${dimensions}.`);
            if (records.length > 512 || dimensions <= 0 || dimensions > 4096)
              throw new Error('Oversized native vector page.');
            if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid native vector limit.');
            const packed = new Uint8Array(records.length * dimensions * 4);
            const sorted = [...records].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
            const ranksById = new Map(EffectArray.map(sorted, (record, index) => [record.id, index] as const));
            if (ranksById.size !== records.length) throw new Error('Duplicate native vector record ID.');
            const ranks = new Uint32Array(records.length);
            EffectArray.forEach(records, (record, index) => {
              if (record.vector.byteLength !== dimensions * 4)
                throw new Error(
                  `Stored vector ${record.id} has ${record.vector.byteLength} bytes; expected ${dimensions * 4}.`,
                );
              packed.set(record.vector, index * dimensions * 4);
              ranks[index] = ranksById.get(record.id)!;
            });
            let output: unknown;
            try {
              output = await binding.searchBatch(
                1,
                packed,
                new Float64Array(query),
                ranks,
                Math.min(limit, records.length),
                -1,
                true,
              );
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : String(cause);
              const invalid = /invalid-row:(\d+):(non-finite|not-normalized)/u.exec(message);
              if (invalid) {
                const record = records[Number(invalid[1])];
                if (record)
                  throw new Error(
                    `Stored vector ${record.id} ${invalid[2] === 'non-finite' ? 'contains a non-finite component' : 'is not L2-normalized'}.`,
                    {cause},
                  );
              }
              throw cause;
            }
            const result = await Schema.decodeUnknownPromise(resultSchema)(output);
            if (
              result.indices.length !== result.scores.length ||
              result.indices.length > limit ||
              new Set(result.indices).size !== result.indices.length
            )
              throw new Error('Malformed native vector response.');
            return EffectArray.map(result.indices, (index, position) => {
              if (
                !Number.isInteger(index) ||
                index < 0 ||
                index >= records.length ||
                Math.abs(result.scores[position]) > 1
              )
                throw new Error('Malformed native vector result.');
              return {id: records[index].id, score: result.scores[position]};
            });
          })(),
        })),
        ({pending}) =>
          Effect.tryPromise({
            try: () => pending,
            catch: cause =>
              NativeVectorSearchError.make({message: cause instanceof Error ? cause.message : String(cause)}),
          }),
        // napi2 AbortSignal rejects early even for running tasks. Drain the original
        // bounded task instead, so interruption cannot outlive its owned page.
        ({pending}) =>
          Effect.promise(() =>
            pending.then(
              () => undefined,
              () => undefined,
            ),
          ),
      ),
  };
}
