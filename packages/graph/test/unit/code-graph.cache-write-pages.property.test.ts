import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {CODE_GRAPH_CACHE_TRANSACTION_LIMITS} from '@threadnote/graph/cache_capacity';
import {codeGraphCacheWritePages} from '@threadnote/graph/store/cache';

describe('code graph cache write page properties', () => {
  it('partitions without loss, reordering, mutation, or oversized SQLite statements', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), {maxLength: 1_200}), rows => {
        const before = [...rows];
        const pages = codeGraphCacheWritePages(rows);

        expect(pages.flat()).toEqual(rows);
        expect(pages).toHaveLength(Math.ceil(rows.length / CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows));
        expect(
          EffectArray.every(pages, page => page.length > 0 && page.length <= CODE_GRAPH_CACHE_TRANSACTION_LIMITS.rows),
        ).toBe(true);
        expect(rows).toEqual(before);
      }),
      {numRuns: 150},
    );
  });
});
