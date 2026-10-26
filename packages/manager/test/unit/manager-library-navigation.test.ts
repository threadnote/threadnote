import fc from 'fast-check';
import {expect, it} from 'vitest';
import {canonicalizeLibraryHistory, emptyLibraryHistory, visitLibraryUri} from '../../src/library_navigation.js';

it('truncates forward visits, ignores the current URI and canonicalizes only the accepted current request', () => {
  const history = visitLibraryUri(visitLibraryUri(emptyLibraryHistory, 'a'), 'alias');
  expect(visitLibraryUri(history, 'alias')).toBe(history);
  expect(canonicalizeLibraryHistory(history, 'a', 'late')).toBe(history);
  const canonical = canonicalizeLibraryHistory(history, 'alias', 'b');
  expect(canonical.entries).toEqual(['a', 'b']);
  expect(visitLibraryUri({...canonical, index: 0}, 'c')).toEqual({entries: ['a', 'c'], index: 1});
  expect(history.entries).toEqual(['a', 'alias']);
});

it('keeps a bounded immutable history with a valid cursor for arbitrary visits and branches', () => {
  fc.assert(
    fc.property(
      fc.array(fc.record({uri: fc.string({minLength: 1}), back: fc.boolean()}), {maxLength: 250}),
      actions => {
        let history = emptyLibraryHistory;
        const expected: string[] = [];
        let position = -1;
        for (const action of actions) {
          const old = JSON.stringify(history);
          const index = action.back && history.index > 0 ? history.index - 1 : history.index;
          const next = visitLibraryUri({...history, index}, action.uri);
          if (action.back && position > 0) position -= 1;
          if (expected[position] !== action.uri) {
            expected.splice(position + 1);
            expected.push(action.uri);
            if (expected.length > 100) expected.shift();
            position = expected.length - 1;
          }
          expect(next.entries).toEqual(expected);
          expect(next.index).toBe(position);
          expect(next.entries.length).toBeLessThanOrEqual(100);
          expect(JSON.stringify(history)).toBe(old);
          history = next;
        }
      },
    ),
    {numRuns: 60},
  );
});
