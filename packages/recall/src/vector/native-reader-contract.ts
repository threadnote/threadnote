import {Array as EffectArray, String as EffectString} from 'effect';
/** Private recall-to-native protocol. Public ready-read requests never contain these predicates. */
export interface NativeVectorPredicate {
  readonly sql: string;
  readonly params: readonly string[];
}

export interface NativeVectorReadRequest {
  readonly dbPath: string;
  readonly generation: string;
  readonly model: {
    readonly id: string;
    readonly sha256: string;
    readonly dimensions: number;
    readonly embeddingRecipe: string;
    readonly chunkerVersion: number;
  };
  readonly expectedPreparationJobId: string;
  readonly corpusGeneration: string;
  readonly limit: number;
  readonly selection: NativeVectorPredicate;
  readonly aliasScope: NativeVectorPredicate;
  readonly aliasEligibility: NativeVectorPredicate;
}

export type NativeVectorReadResult = {
  /** Whether metadata reached the old inner lexical-corpus callback position. */
  readonly corpusCheckRequired: boolean;
} & (
  | {readonly status: 'success'; readonly scores: readonly {readonly uri: string; readonly score: number}[]}
  | {readonly status: 'absent'}
  | {readonly status: 'corrupt' | 'operation-error' | 'corpus-changed' | 'cancelled'; readonly message: string}
);

export interface NativeVectorCancellationToken {
  readonly cancel: () => void;
}

export interface NativeVectorReaderBinding {
  readonly CancellationToken: new () => NativeVectorCancellationToken;
  readonly readSelected: (
    request: NativeVectorReadRequest,
    query: Float64Array | undefined,
    cancellation: NativeVectorCancellationToken,
  ) => Promise<NativeVectorReadResult>;
}

/** N-API's UTF-8 strings do not preserve an unpaired UTF-16 surrogate. */
export function nativeVectorStringsSupported(strings: readonly string[]): boolean {
  return EffectArray.every(strings, value => !/[\uD800-\uDFFF]/u.test(value) && !EffectString.includes('\0')(value));
}

export function nativeVectorRequestSupported(
  request: NativeVectorReadRequest,
  query: readonly number[] | undefined,
): boolean {
  return (
    Number.isSafeInteger(request.model.dimensions) &&
    request.model.dimensions > 0 &&
    Number.isSafeInteger(request.limit) &&
    request.limit >= 0 &&
    (query === undefined ||
      (query.length === request.model.dimensions &&
        EffectArray.every(query, component => Number.isFinite(component) && Math.abs(component) <= 1))) &&
    nativeVectorStringsSupported([
      request.dbPath,
      request.generation,
      request.model.id,
      request.model.sha256,
      request.model.embeddingRecipe,
      request.expectedPreparationJobId,
      request.corpusGeneration,
      request.selection.sql,
      ...request.selection.params,
      request.aliasScope.sql,
      ...request.aliasScope.params,
      request.aliasEligibility.sql,
      ...request.aliasEligibility.params,
    ])
  );
}
