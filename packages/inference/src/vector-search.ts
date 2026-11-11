import {Array as EffectArray} from 'effect';
import {Context, Effect, Layer, Schema} from 'effect';

export interface VectorRecord {
  readonly id: string;
  readonly vector: readonly number[];
}

export interface VectorSearchResult {
  readonly id: string;
  readonly score: number;
}

export class VectorInvalid extends Schema.TaggedError<VectorInvalid, {readonly brand: unique symbol}>()(
  'VectorInvalid',
  {
    message: Schema.String,
  },
) {}

export interface VectorSearchShape {
  readonly normalize: (vector: readonly number[]) => Effect.Effect<readonly number[], VectorInvalid>;
  readonly search: (
    query: readonly number[],
    records: readonly VectorRecord[],
    options: {readonly dimensions: number; readonly limit: number; readonly minimumScore?: number},
  ) => Effect.Effect<readonly VectorSearchResult[], VectorInvalid>;
}

export class VectorSearch extends Context.Service<VectorSearch, VectorSearchShape>()(
  '@threadnote/inference/vector-search/VectorSearch',
) {
  static readonly layer = Layer.succeed(
    VectorSearch,
    VectorSearch.of({
      normalize: vector => Effect.try({try: () => normalizeVector(vector), catch: invalidVector}),
      search: (query, records, options) =>
        Effect.try({
          try: () => searchExactVectors(query, records, options),
          catch: invalidVector,
        }),
    }),
  );
}

export function normalizeVector(vector: readonly number[]): readonly number[] {
  assertFiniteVector(vector);
  let squaredMagnitude = 0;
  for (const component of vector) {
    squaredMagnitude += component * component;
  }
  if (!Number.isFinite(squaredMagnitude) || squaredMagnitude <= 0) {
    throw new Error('Vector magnitude must be finite and greater than zero.');
  }
  const inverseMagnitude = 1 / Math.sqrt(squaredMagnitude);
  return EffectArray.map(vector, component => component * inverseMagnitude);
}

export function searchExactVectors(
  query: readonly number[],
  records: readonly VectorRecord[],
  options: {readonly dimensions: number; readonly limit: number; readonly minimumScore?: number},
): readonly VectorSearchResult[] {
  if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
    throw new Error('Vector dimensions must be a positive integer.');
  }
  if (!Number.isInteger(options.limit) || options.limit < 0) {
    throw new Error('Vector search limit must be a non-negative integer.');
  }
  if (query.length !== options.dimensions) {
    throw new Error(`Query vector has ${query.length} dimensions; expected ${options.dimensions}.`);
  }
  const normalizedQuery = normalizeVector(query);
  const seen = new Set<string>();
  const results: VectorSearchResult[] = [];
  const compareBestFirst = (left: VectorSearchResult, right: VectorSearchResult): number =>
    right.score - left.score || compareCodeUnits(left.id, right.id);
  for (const record of records) {
    if (seen.has(record.id)) {
      throw new Error(`Duplicate vector record ID: ${record.id}.`);
    }
    seen.add(record.id);
    if (record.vector.length !== options.dimensions) {
      throw new Error(
        `Vector record ${record.id} has ${record.vector.length} dimensions; expected ${options.dimensions}.`,
      );
    }
    assertFiniteVector(record.vector);
    let score = 0;
    for (let index = 0; index < options.dimensions; index += 1) {
      score += normalizedQuery[index] * record.vector[index];
    }
    score = Math.max(-1, Math.min(1, score));
    if (score >= (options.minimumScore ?? -1)) {
      offerBoundedBest(results, {id: record.id, score}, options.limit, compareBestFirst);
    }
  }
  return results.sort(compareBestFirst);
}

function assertFiniteVector(vector: readonly number[]): void {
  if (vector.length === 0 || EffectArray.some(vector, component => !Number.isFinite(component))) {
    throw new Error('Vector must contain at least one finite component.');
  }
}

function invalidVector(cause: unknown): VectorInvalid {
  return VectorInvalid.make({message: cause instanceof Error ? cause.message : String(cause)});
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function offerBoundedBest<T>(heap: T[], item: T, limit: number, compareBestFirst: (left: T, right: T) => number): void {
  if (limit <= 0) return;
  if (heap.length < limit) {
    heap.push(item);
    bubbleWorstUp(heap, heap.length - 1, compareBestFirst);
    return;
  }
  if (compareBestFirst(item, heap[0]) >= 0) return;
  heap[0] = item;
  sinkWorstDown(heap, 0, compareBestFirst);
}

function bubbleWorstUp<T>(heap: T[], start: number, compareBestFirst: (left: T, right: T) => number): void {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareBestFirst(heap[index], heap[parent]) <= 0) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function sinkWorstDown<T>(heap: T[], start: number, compareBestFirst: (left: T, right: T) => number): void {
  let index = start;
  for (;;) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    const worse = right < heap.length && compareBestFirst(heap[right], heap[left]) > 0 ? right : left;
    if (compareBestFirst(heap[worse], heap[index]) <= 0) return;
    [heap[index], heap[worse]] = [heap[worse], heap[index]];
    index = worse;
  }
}
