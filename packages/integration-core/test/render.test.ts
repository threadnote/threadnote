import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {splitUtf8} from '../src/render.js';

describe('bounded UTF-8 chunks', () => {
  it('reconstructs Unicode text within the byte budget without splitting code points', () => {
    const text = fc
      .array(
        fc.integer({min: 0, max: 0x10ffff}).filter(value => value < 0xd800 || value > 0xdfff),
        {maxLength: 200},
      )
      .map(values => String.fromCodePoint(...values));
    fc.assert(
      fc.property(text, fc.integer({min: 4, max: 128}), (value, budget) => {
        const chunks = splitUtf8(value, budget);
        expect(chunks.join('')).toBe(value);
        for (const chunk of chunks) {
          expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(budget);
          expect(new TextDecoder('utf-8', {fatal: true}).decode(new TextEncoder().encode(chunk))).toBe(chunk);
        }
      }),
      {numRuns: 100},
    );
  });

  it('rejects byte limits that cannot hold a Unicode scalar value', () => {
    for (const limit of [0, 3, 4.5, Infinity]) expect(() => splitUtf8('value', limit)).toThrow(RangeError);
  });
});
