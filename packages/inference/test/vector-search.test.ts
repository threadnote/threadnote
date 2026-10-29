import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import {normalizeVector, searchExactVectors} from '@threadnote/inference/vector-search';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('exact vector search', () => {
  it('normalizes query vectors and applies deterministic score/id ordering', () => {
    const diagonal = normalizeVector([1, 1]);
    const results = searchExactVectors(
      [4, 0],
      [
        {id: 'z', vector: [1, 0]},
        {id: 'a', vector: [1, 0]},
        {id: 'diagonal', vector: diagonal},
        {id: 'opposite', vector: [-1, 0]},
      ],
      {dimensions: 2, limit: 3, minimumScore: 0},
    );
    expect(results.slice(0, 2)).toEqual([
      {id: 'a', score: 1},
      {id: 'z', score: 1},
    ]);
    expect(results[2]?.id).toBe('diagonal');
    expect(results[2]?.score).toBeCloseTo(Math.SQRT1_2);
  });

  it('rejects mixed dimensions, duplicate IDs, non-finite components, and zero queries', () => {
    expect(() => searchExactVectors([0, 0], [], {dimensions: 2, limit: 1})).toThrow('magnitude');
    expect(() =>
      searchExactVectors(
        [1, 0],
        [
          {id: 'same', vector: [1, 0]},
          {id: 'same', vector: [0, 1]},
        ],
        {dimensions: 2, limit: 1},
      ),
    ).toThrow('Duplicate');
    expect(() => searchExactVectors([1, 0], [{id: 'bad', vector: [1]}], {dimensions: 2, limit: 1})).toThrow(
      'dimensions',
    );
    expect(() => searchExactVectors([1, 0], [{id: 'bad', vector: [Number.NaN, 0]}], {dimensions: 2, limit: 1})).toThrow(
      'finite',
    );
  });

  it('keeps deterministic top-K results while validating every record at limit zero', () => {
    const records = Array.from({length: 2_000}, (_, index) => ({
      id: `record-${Effect.pipe(String(index), EffectString.padStart(4, '0'))}`,
      vector: normalizeVector([index + 1, 2_000 - index]),
    }));
    const expected = EffectArray.map(records, record => ({id: record.id, score: record.vector[0]}))
      .sort((left, right) => right.score - left.score || Effect.pipe(left.id, EffectString.localeCompare(right.id)))
      .slice(0, 7);

    expect(searchExactVectors([1, 0], records, {dimensions: 2, limit: 7})).toEqual(expected);
    expect(() =>
      searchExactVectors(
        [1, 0],
        [
          {id: 'same', vector: [1, 0]},
          {id: 'same', vector: [0, 1]},
        ],
        {dimensions: 2, limit: 0},
      ),
    ).toThrow('Duplicate');
  });
});
