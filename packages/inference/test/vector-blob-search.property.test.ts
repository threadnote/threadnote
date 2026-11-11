import {Array as EffectArray} from 'effect';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {
  offerBoundedBest,
  searchExactVectorBlobs,
  type VectorBlobRecord,
  type VectorSearchResult,
} from '@threadnote/inference/vector-search';

const compare = (a: VectorSearchResult, b: VectorSearchResult): number =>
  b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function encode(values: readonly number[], offset = 0): Uint8Array {
  const bytes = new Uint8Array(values.length * 4 + offset + 3).subarray(offset, offset + values.length * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  EffectArray.forEach(values, (value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

// Deliberately materialize and full-sort: independent of the bounded heap and
// of direct-blob scoring. Float32 rounding occurs at the storage boundary.
function oracle(query: readonly number[], records: readonly VectorBlobRecord[], limit: number, minimumScore: number) {
  const inverse = 1 / Math.sqrt(EffectArray.reduce(query, 0, (sum, value) => sum + value * value));
  const normalized = EffectArray.map(query, value => value * inverse);
  return EffectArray.filter(
    EffectArray.map(records, record => {
      const view = new DataView(record.vector.buffer, record.vector.byteOffset, record.vector.byteLength);
      const decoded = Array.from({length: query.length}, (_, index) => view.getFloat32(index * 4, true));
      const score = EffectArray.reduce(decoded, 0, (sum, value, index) => sum + normalized[index] * value);
      return {id: record.id, score: Math.max(-1, Math.min(1, score))};
    }),
    result => result.score >= minimumScore,
  )
    .sort(compare)
    .slice(0, limit);
}

const cases = FC.integer({min: 1, max: 8}).chain(dimensions =>
  FC.record({
    query: FC.tuple(
      FC.integer({min: 1, max: 20}),
      FC.array(FC.integer({min: -20, max: 20}), {
        minLength: dimensions - 1,
        maxLength: dimensions - 1,
      }),
    ).map(([head, tail]) => [head, ...tail]),
    values: FC.array(
      FC.array(FC.integer({min: -8, max: 8}), {
        minLength: dimensions,
        maxLength: dimensions,
      }),
      {maxLength: 40},
    ),
    offset: FC.integer({min: 0, max: 7}),
    limit: FC.integer({min: 0, max: 45}),
    threshold: FC.integer({min: -100, max: 100}).map(value => value / 100),
    pageSize: FC.integer({min: 1, max: 12}),
  }).chain(input => {
    const records = EffectArray.map(input.values, (values, index) => ({
      id: `${index % 2 === 0 ? '\uE000' : '\u{10000}'}-${index}`,
      vector: encode(
        EffectArray.map(values, value => value / 8),
        input.offset,
      ),
    }));
    return FC.shuffledSubarray(records, {minLength: records.length, maxLength: records.length}).map(permutation => ({
      ...input,
      records,
      permutation,
      dimensions,
    }));
  }),
);

describe('Float32LE exact search', () => {
  fcProp(
    it,
    'matches an independent scalar oracle across permutations, page partitions and byte offsets',
    {input: cases},
    ({input}) => {
      const {query, records, permutation, limit, threshold, dimensions, pageSize} = input;
      const before = EffectArray.map(records, record => Array.from(new Uint8Array(record.vector.buffer)));
      const queryBefore = [...query];
      const options = {dimensions, limit, minimumScore: threshold};
      const expected = oracle(query, records, limit, threshold);
      expect(searchExactVectorBlobs(query, records, options)).toEqual(expected);
      expect(searchExactVectorBlobs(query, permutation, options)).toEqual(expected);
      const heap: VectorSearchResult[] = [];
      for (let cursor = 0; cursor < permutation.length; cursor += pageSize) {
        const page = searchExactVectorBlobs(query, permutation.slice(cursor, cursor + pageSize), options);
        for (const result of page) offerBoundedBest(heap, result, limit, compare);
        expect(heap.length).toBeLessThanOrEqual(limit);
      }
      expect(heap.sort(compare)).toEqual(expected);
      expect(query).toEqual(queryBefore);
      expect(EffectArray.map(records, record => Array.from(new Uint8Array(record.vector.buffer)))).toEqual(before);
    },
    {fastCheck: {numRuns: 150}},
  );

  it('keeps raw candidate magnitude, clamps and includes exact thresholds before UTF-16 top-k', () => {
    const records = EffectArray.map(['\uE000', '\u{10000}', 'a'], id => ({id, vector: encode([2, 0], 1)}));
    expect(searchExactVectorBlobs([3, 0], records, {dimensions: 2, limit: 2, minimumScore: 1})).toEqual([
      {id: 'a', score: 1},
      {id: '\u{10000}', score: 1},
    ]);
    const value = Math.fround(0.64);
    const candidate = [{id: 'boundary', vector: encode([value, 0])}];
    expect(searchExactVectorBlobs([1, 0], candidate, {dimensions: 2, limit: 1, minimumScore: value})).toEqual([
      {id: 'boundary', score: value},
    ]);
    expect(
      searchExactVectorBlobs([1, 0], candidate, {dimensions: 2, limit: 1, minimumScore: value + Number.EPSILON}),
    ).toEqual([]);
  });

  it('validates every blob even outside top-k or with a zero limit', () => {
    for (const limit of [0, 1]) {
      for (const vector of [new Uint8Array(7), encode([NaN, 0]), encode([Infinity, 0]), encode([-Infinity, 0])]) {
        expect(() =>
          searchExactVectorBlobs(
            [1, 0],
            [
              {id: 'best', vector: encode([1, 0])},
              {id: 'bad', vector},
            ],
            {dimensions: 2, limit},
          ),
        ).toThrow();
      }
      expect(() =>
        searchExactVectorBlobs(
          [1, 0],
          [
            {id: 'duplicate', vector: encode([1, 0])},
            {id: 'duplicate', vector: encode([0, 1])},
          ],
          {dimensions: 2, limit},
        ),
      ).toThrow('Duplicate vector record ID');
    }
  });
});
