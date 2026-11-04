import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  candidateSynopsis,
  candidateSynopsisMayContain,
  candidateSynopsisMatches,
  candidateSynopsisBinding,
} from '@threadnote/graph/store/resolution/candidate_synopsis';
import {
  candidatePairHint,
  canonicalCandidatePairs,
  type CandidatePair,
} from '@threadnote/graph/store/resolution/candidate_pages';

const scalar = fc
  .array(fc.constantFrom('a', 'Z', '\0', '\ufeff', '🙂', '\ue000', 'é'), {maxLength: 24})
  .map(xs => EffectArray.join(xs, ''));
describe('sealed candidate synopsis format4', () => {
  it('has no false negatives against independent full128-bit offset construction', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(scalar, scalar), {maxLength: 64}), input => {
        const pairs = canonicalCandidatePairs(input);
        const expected = new Uint8Array(128);
        for (const pair of pairs) {
          const hint = candidatePairHint(pair);
          for (let offset = 0; offset < 8; offset++) {
            const bit = (hint[offset * 2] * 256 + hint[offset * 2 + 1]) % 1024;
            expected[Math.floor(bit / 8)] |= 2 ** (bit % 8);
          }
        }
        const actual = candidateSynopsis(EffectArray.map(pairs, candidatePairHint));
        expect(actual).toEqual(expected);
        for (const pair of pairs) expect(candidateSynopsisMayContain(actual, candidatePairHint(pair))).toBe(true);
        expect(candidateSynopsisMatches(actual, pairs)).toBe(true);
      }),
      {numRuns: 80},
    );
  });
  it('keeps forced false positives as candidates rather than full-value matches', () => {
    const all = new Uint8Array(128).fill(255);
    expect(candidateSynopsisMayContain(all, candidatePairHint(['domain', 'absent']))).toBe(true);
    expect(candidateSynopsisMatches(all, [['domain', 'actual']])).toBe(false);
    expect(() => candidateSynopsisMayContain(new Uint8Array(127), new Uint8Array(16))).toThrow();
  });
  it('binds exact filters to source generation, file, page and complete payload identity', () => {
    const pair: CandidatePair = ['domain', 'value'];
    const bits = candidateSynopsis([candidatePairHint(pair)]);
    const base = candidateSynopsisBinding(1, 2, 0, 'raw', 'stored', bits);
    for (const changed of [
      candidateSynopsisBinding(2, 2, 0, 'raw', 'stored', bits),
      candidateSynopsisBinding(1, 3, 0, 'raw', 'stored', bits),
      candidateSynopsisBinding(1, 2, 1, 'raw', 'stored', bits),
      candidateSynopsisBinding(1, 2, 0, 'other', 'stored', bits),
      candidateSynopsisBinding(1, 2, 0, 'raw', 'other', bits),
      candidateSynopsisBinding(1, 2, 0, 'raw', 'stored', new Uint8Array(128)),
    ])
      expect(changed).not.toEqual(base);
  });
});
