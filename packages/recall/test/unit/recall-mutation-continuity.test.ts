import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {recallIndexCanonicalMutationContinuityAllowsIncrementalRefresh as allowsIncremental} from '@threadnote/recall/index/freshness';

describe('canonical mutation continuity evidence', () => {
  it('requires nonempty canonical endpoints even when legacy markers appear to match', () => {
    fc.assert(
      fc.property(fc.string({minLength: 1, maxLength: 48}), generation => {
        for (const [persisted, observed] of [
          ['', ''],
          ['', generation],
          [generation, ''],
        ]) {
          expect(
            allowsIncremental({
              persistedGeneration: persisted,
              observedGeneration: observed,
              markerPreviousGeneration: persisted,
              markerCurrentGeneration: observed,
            }),
          ).toBe(false);
          expect(allowsIncremental({persistedGeneration: persisted, observedGeneration: observed})).toBe(false);
        }
      }),
      {numRuns: 64},
    );
  });

  it('preserves same-generation and exact tracked transitions while rejecting skipped transitions', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({minLength: 1, maxLength: 48}), {minLength: 3, maxLength: 3}),
        ([indexed, middle, current]) => {
          expect(allowsIncremental({persistedGeneration: indexed, observedGeneration: indexed})).toBe(true);
          expect(
            allowsIncremental({
              persistedGeneration: indexed,
              observedGeneration: current,
              markerPreviousGeneration: indexed,
              markerCurrentGeneration: current,
            }),
          ).toBe(true);
          expect(
            allowsIncremental({
              persistedGeneration: indexed,
              observedGeneration: current,
              markerPreviousGeneration: middle,
              markerCurrentGeneration: current,
            }),
          ).toBe(false);
        },
      ),
      {numRuns: 64},
    );
  });
});
