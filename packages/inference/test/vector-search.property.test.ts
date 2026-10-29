import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  normalizeVector,
  searchExactVectors,
  type VectorRecord,
  type VectorSearchResult,
} from '@threadnote/inference/vector-search';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const componentArbitrary = FC.integer({max: 100, min: -100});
const nonZeroComponentArbitrary = FC.oneof(FC.integer({max: -1, min: -100}), FC.integer({max: 100, min: 1}));
const VECTOR_ID_LABELS = [
  '!bang',
  '-dash',
  '0digit',
  'A-upper',
  '_under',
  'a-lower',
  'é-accent',
  'Ω-greek',
  '中-cjk',
  '😀-emoji',
] as const;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonZeroVectorArbitrary(dimensions: number): FC.Arbitrary<readonly number[]> {
  return FC.tuple(
    nonZeroComponentArbitrary,
    FC.array(componentArbitrary, {maxLength: dimensions - 1, minLength: dimensions - 1}),
  ).map(([head, tail]) => [head, ...tail]);
}

function oracleNormalize(vector: readonly number[]): readonly number[] {
  const inverseMagnitude =
    1 / Math.sqrt(EffectArray.reduce(vector, 0, (sum, component) => sum + component * component));
  return EffectArray.map(vector, component => component * inverseMagnitude);
}

function oracleSearch(
  query: readonly number[],
  records: readonly VectorRecord[],
  options: {readonly limit: number; readonly minimumScore: number},
): readonly VectorSearchResult[] {
  const normalizedQuery = oracleNormalize(query);
  return EffectArray.filter(
    EffectArray.map(records, record => {
      const dotProduct = EffectArray.reduce(
        record.vector,
        0,
        (score, component, index) => score + component * normalizedQuery[index],
      );
      return {id: record.id, score: Math.max(-1, Math.min(1, dotProduct))};
    }),
    result => result.score >= options.minimumScore,
  )
    .sort((left, right) => right.score - left.score || compareCodeUnits(left.id, right.id))
    .slice(0, options.limit);
}

const vectorSearchCaseArbitrary = FC.integer({max: 8, min: 1}).chain(dimensions =>
  FC.uniqueArray(FC.integer({max: 999, min: 0}), {maxLength: 24, minLength: 0}).chain(ids =>
    FC.tuple(
      nonZeroVectorArbitrary(dimensions),
      FC.array(nonZeroVectorArbitrary(dimensions).map(oracleNormalize), {
        maxLength: ids.length,
        minLength: ids.length,
      }),
      FC.array(FC.constantFrom(...VECTOR_ID_LABELS), {
        maxLength: ids.length,
        minLength: ids.length,
      }),
      FC.integer({max: 28, min: 0}),
      FC.integer({max: 100, min: -100}),
    ).chain(([query, vectors, labels, limit, minimumScorePercent]) => {
      const records = EffectArray.map(ids, (id, index): VectorRecord => ({
        id: `${labels[index]}-${Effect.pipe(String(id), EffectString.padStart(3, '0'))}`,
        vector: vectors[index],
      }));
      return FC.shuffledSubarray(records, {maxLength: records.length, minLength: records.length}).map(permutation => ({
        dimensions,
        limit,
        minimumScore: minimumScorePercent / 100,
        permutation,
        query,
        records,
      }));
    }),
  ),
);

describe('exact vector search properties', () => {
  fcProp(
    it,
    'normalization produces a finite unit vector and is invariant under positive scaling',
    {
      scale: FC.constantFrom(0.25, 0.5, 2, 4, 8),
      vector: FC.integer({max: 8, min: 1}).chain(nonZeroVectorArbitrary),
    },
    ({scale, vector}) => {
      const input = [...vector];
      const normalized = normalizeVector(vector);
      const renormalized = normalizeVector(normalized);
      const scaled = normalizeVector(EffectArray.map(vector, component => component * scale));

      expect(vector).toEqual(input);
      expect(normalized).toHaveLength(vector.length);
      expect(EffectArray.every(normalized, Number.isFinite)).toBe(true);
      expect(Math.sqrt(EffectArray.reduce(normalized, 0, (sum, component) => sum + component * component))).toBeCloseTo(
        1,
        12,
      );
      EffectArray.forEach(normalized, (component, index) => {
        expect(renormalized[index]).toBeCloseTo(component, 12);
        expect(scaled[index]).toBeCloseTo(component, 12);
      });
    },
    {fastCheck: {numRuns: 150}},
  );

  fcProp(
    it,
    'matches a full-sort oracle and is independent of record permutation',
    {searchCase: vectorSearchCaseArbitrary},
    ({searchCase}) => {
      const {dimensions, limit, minimumScore, permutation, query, records} = searchCase;
      const options = {dimensions, limit, minimumScore};
      const expected = oracleSearch(query, records, {limit, minimumScore});
      const actual = searchExactVectors(query, records, options);
      const permuted = searchExactVectors(query, permutation, options);

      expect(actual).toEqual(expected);
      expect(permuted).toEqual(expected);
      expect(actual).toHaveLength(Math.min(expected.length, limit));
      expect(actual.length).toBeLessThanOrEqual(records.length);
      expect(new Set(EffectArray.map(actual, result => result.id)).size).toBe(actual.length);
      for (const result of actual) {
        expect(Number.isFinite(result.score)).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(-1);
        expect(result.score).toBeLessThanOrEqual(1);
        expect(result.score).toBeGreaterThanOrEqual(minimumScore);
      }
    },
    {fastCheck: {numRuns: 150}},
  );

  fcProp(
    it,
    'orders exact score ties by locale-independent ID regardless of input order',
    {
      ids: FC.uniqueArray(FC.constantFrom(...VECTOR_ID_LABELS), {
        maxLength: VECTOR_ID_LABELS.length,
        minLength: 2,
      }),
    },
    ({ids}) => {
      const records = EffectArray.map(ids, (id): VectorRecord => ({
        id,
        vector: [1, 0],
      }));
      const expectedIds = EffectArray.map(records, record => record.id).sort(compareCodeUnits);

      expect(
        EffectArray.map(
          searchExactVectors([1, 0], records, {dimensions: 2, limit: records.length}),
          result => result.id,
        ),
      ).toEqual(expectedIds);
      expect(
        EffectArray.map(
          searchExactVectors([1, 0], [...records].reverse(), {dimensions: 2, limit: records.length}),
          result => result.id,
        ),
      ).toEqual(expectedIds);
    },
    {fastCheck: {numRuns: 75}},
  );
});
