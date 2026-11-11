import {createRequire} from 'node:module';
import {Array as EffectArray} from 'effect';
import {beforeAll, describe, expect, it} from 'vitest';
import {normalizeVector, searchExactVectorBlobs} from '../src/vector-search.js';

interface BatchResult {
  indices: number[];
  scores: number[];
}
interface NativeVector {
  searchBatch(
    protocol: number,
    rows: Uint8Array,
    query: Float64Array,
    ranks: Uint32Array,
    limit: number,
    threshold: number,
    validateUnit: boolean,
  ): Promise<BatchResult>;
}

// This suite is an explicit experiment: build with scripts/build-native-vector-search.ts first.
let native: NativeVector;

function encode(values: readonly number[], offset = 3): Uint8Array {
  const bytes = new Uint8Array(offset + values.length * 4 + 5).subarray(offset, offset + values.length * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  EffectArray.forEach(values, (value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

describe.runIf(process.env.THREADNOTE_NATIVE_VECTOR_EXPERIMENT === '1')(
  'experimental native vector Node-API boundary',
  () => {
    beforeAll(() => {
      native = createRequire(import.meta.url)('../native-vector/vector-search.node');
    });
    it('loads in Bun and exactly matches ordered scalar scores, UTF16 ties and cutoffs across bounded batches', async () => {
      for (let seed = 1; seed <= 40; seed += 1) {
        const dimensions = 1 + (seed % 11);
        const query = Array.from({length: dimensions}, (_, i) => ((seed * 3 + i * 7) % 17) - 8 || 1);
        const records = Array.from({length: 31}, (_, row) => ({
          id: `${row % 2 ? '\uE000' : '\u{10000}'}-${30 - row}`,
          vector: encode(
            Array.from({length: dimensions}, (_, column) => ((((row % 7) * 3 + column * 5) % 19) - 9) / 8),
          ),
        }));
        const sortedIds = EffectArray.map(records, row => row.id).sort();
        const ranks = new Uint32Array(EffectArray.map(records, row => sortedIds.indexOf(row.id)));
        const packed = new Uint8Array(records.length * dimensions * 4 + 7).subarray(
          3,
          3 + records.length * dimensions * 4,
        );
        EffectArray.forEach(records, (row, index) => packed.set(row.vector, index * dimensions * 4));
        const limit = seed % 13;
        const threshold = seed % 3 === 0 ? 1 : seed % 3 === 1 ? -1 : 0;
        const expected = searchExactVectorBlobs(query, records, {dimensions, limit, minimumScore: threshold});
        const actual = await native.searchBatch(
          1,
          packed,
          new Float64Array(normalizeVector(query)),
          ranks,
          limit,
          threshold,
          false,
        );
        expect(
          EffectArray.map(actual.indices, (index, i) => ({id: records[index].id, score: actual.scores[i]})),
        ).toEqual(expected);
      }
    });

    it('owns input copies before queueing and preserves candidate values without normalization', async () => {
      const rows = encode([1.001, 0, 1, 0]);
      const before = rows.slice();
      const query = new Float64Array([0.5, 0]);
      const ranks = new Uint32Array([2, 1]);
      const pending = native.searchBatch(1, rows, query, ranks, 4, -1, true);
      expect(rows).toEqual(before);
      rows.fill(0);
      query.fill(0);
      ranks.fill(0);
      expect(await pending).toEqual({indices: [0, 1], scores: [Math.fround(1.001) * 0.5, 0.5]});
    });

    it('rejects malformed protocol and invalid graph rows visibly, with bounded admission', async () => {
      const call = (protocol: number, bytes = encode([1]), ranks = new Uint32Array([0])) =>
        native.searchBatch(protocol, bytes, new Float64Array([1]), ranks, 1, -1, false);
      expect(() => call(2)).toThrow(/protocol/);
      expect(() => call(1, new Uint8Array(3))).toThrow(/Malformed/);
      expect(() => call(1, encode([1, 1]), new Uint32Array([0, 0]))).toThrow(/rank/);
      expect(() => call(1, new Uint8Array(513 * 4), new Uint32Array(513))).toThrow(/oversized/);
      await expect(call(1, encode([Number.POSITIVE_INFINITY]))).rejects.toThrow(/non-finite/);
      const first = call(1);
      const second = call(1);
      expect(() => call(1)).toThrow(/capacity/);
      await Promise.all([first, second]);
      expect(await call(1)).toEqual({indices: [0], scores: [1]});
    });
  },
);
