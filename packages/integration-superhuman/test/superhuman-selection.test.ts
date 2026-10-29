import {Array as EffectArray} from 'effect';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {mergeResolvedSuperhumanSelections, retainedSuperhumanSelection} from '../src/selection.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('Superhuman selection presentation', () => {
  it('preserves whole-document and explicit-page scope through chip reconstruction and deduplication', () => {
    const documents = fc.uniqueArray(
      fc.record({
        id: fc.constantFrom('doc_a', 'doc_b', 'doc_c'),
        pages: fc.option(fc.uniqueArray(fc.constantFrom('page_a', 'page_b', 'page_c'), {minLength: 1, maxLength: 3}), {
          nil: undefined,
        }),
      }),
      {selector: item => item.id, minLength: 1, maxLength: 3},
    );
    fc.assert(
      fc.property(documents, scope => {
        const retained = retainedSuperhumanSelection(scope);
        const result = mergeResolvedSuperhumanSelections([...retained.selections, ...retained.selections].reverse());
        const expected = EffectArray.map(scope, item => ({
          id: item.id,
          ...(item.pages === undefined ? {} : {pages: [...item.pages].sort()}),
        })).sort((a, b) => Effect.pipe(a.id, EffectString.localeCompare(b.id)));
        expect(result.documents).toEqual(expected);
        expect(mergeResolvedSuperhumanSelections(result.selections)).toEqual(result);
      }),
      {numRuns: 40},
    );
  });
});
