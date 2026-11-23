import {searchExactVectors} from '@threadnote/inference/vector-search';
import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import {decodeSearchVectorPage, isDecodableVector} from '../../src/vector/blob.js';

function vectorBytes(first: number, second: number): DataView<ArrayBuffer> {
  // An unaligned offset and unused bytes on both sides exercise the blob view boundary.
  const view = new DataView(new ArrayBuffer(13), 3, 8);
  view.setFloat32(0, first, true);
  view.setFloat32(4, second, true);
  return view;
}

function row(symbol_id: string, vector: unknown) {
  return {symbol_id, vector};
}

describe('graph search vector pages', () => {
  it('preserves exact boxed scores, inclusive cutoff, and UTF-16 ties', () => {
    const first = vectorBytes(0.75, Math.sqrt(1 - 0.75 ** 2));
    const second = vectorBytes(0.75, -Math.sqrt(1 - 0.75 ** 2));
    const below = vectorBytes(0.5, Math.sqrt(0.75));
    const above = vectorBytes(0.875, Math.sqrt(1 - 0.875 ** 2));
    const rows = [
      row('\uE000', first),
      row('\u{10000}', new Uint8Array(second.buffer, second.byteOffset, second.byteLength)),
      row('below', below),
      row('above', above.buffer.slice(above.byteOffset, above.byteOffset + above.byteLength)),
    ];
    const vectors = [first, second, below, above];
    const stockRecords = EffectArray.map(rows, (record, index) => ({
      id: record.symbol_id,
      vector: [vectors[index].getFloat32(0, true), vectors[index].getFloat32(4, true)],
    }));
    const options = {dimensions: 2, limit: 3, minimumScore: 0.75};
    const expected = searchExactVectors([1, 0], stockRecords, options);
    expect(expected).toEqual([
      {id: 'above', score: 0.875},
      {id: '\u{10000}', score: 0.75},
      {id: '\uE000', score: 0.75},
    ]);

    const records = decodeSearchVectorPage(rows, 2);
    expect(searchExactVectors([1, 0], records, options)).toEqual(expected);
    expect(searchExactVectors([1, 0], records, {...options, limit: 2})).toEqual(expected.slice(0, 2));

    const obliqueOptions = {dimensions: 2, limit: 4};
    expect(searchExactVectors([0.7, 0.3], records, obliqueOptions)).toEqual(
      searchExactVectors([0.7, 0.3], stockRecords, obliqueOptions),
    );

    if (new Uint8Array(new Uint32Array([1]).buffer)[0] === 1) {
      const [left, right] = records;
      expect(left.vector).toBeInstanceOf(Float32Array);
      expect(right.vector).toBeInstanceOf(Float32Array);
      if (left.vector instanceof Float32Array && right.vector instanceof Float32Array) {
        expect(left.vector.buffer).toBe(right.vector.buffer);
        expect(right.vector.byteOffset - left.vector.byteOffset).toBe(8);
      }
    }
  });

  it.each([
    {
      first: vectorBytes(1, Number.NaN),
      later: new ArrayBuffer(3),
      message: 'Stored vector contains a non-finite component.',
    },
    {
      first: vectorBytes(0, 0),
      later: vectorBytes(Number.POSITIVE_INFINITY, 1),
      message: 'Stored vector is not L2-normalized.',
    },
    {
      first: new ArrayBuffer(3),
      later: vectorBytes(Number.NaN, 0),
      message: 'Stored vector has 3 bytes; expected 8.',
    },
    {
      first: 'malformed',
      later: vectorBytes(0, 0),
      message: 'Stored vector is not a binary SQLite value.',
    },
  ])('reports the first invalid row: $message', ({first, later, message}) => {
    expect(() =>
      decodeSearchVectorPage([row('valid', vectorBytes(1, 0)), row('first', first), row('later', later)], 2),
    ).toThrow(message);
    expect(isDecodableVector(first, 2)).toBe(false);
  });
});
