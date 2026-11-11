import {Option, String as EffectString} from 'effect';
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
  /** JSON array tail owned by the TS identity policy, including its closing bracket. */
  readonly preparationIdentitySuffix: string;
  readonly corpusGeneration?: string;
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

/** Lossless expected metadata stays distinct from Bun/SQLite's UTF-8 bind transport. */
export interface NativeVectorWireRequest extends NativeVectorReadRequest {
  readonly model: NativeVectorReadRequest['model'] & {readonly idUtf16: readonly number[]};
  readonly corpusGenerationUtf16?: readonly number[];
}

export function nativeVectorWireRequest(request: NativeVectorReadRequest): NativeVectorWireRequest {
  const units = (value: string) =>
    Array.from({length: value.length}, (_, index) => Option.getOrThrow(EffectString.charCodeAt(index)(value)));
  return {
    ...structuredClone(request),
    model: {...request.model, idUtf16: units(request.model.id)},
    ...(request.corpusGeneration === undefined ? {} : {corpusGenerationUtf16: units(request.corpusGeneration)}),
  };
}

export interface NativeVectorCancellationToken {
  readonly cancel: () => void;
}

export interface NativeVectorReaderBinding {
  readonly CancellationToken: new () => NativeVectorCancellationToken;
  readonly readSelected: (
    request: NativeVectorWireRequest,
    query: Float64Array | undefined,
    cancellation: NativeVectorCancellationToken,
  ) => Promise<NativeVectorReadResult>;
}
