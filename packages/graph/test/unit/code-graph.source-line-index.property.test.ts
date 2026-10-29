import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {createSourceLineIndex, sourcePositionAt} from '@threadnote/graph/languages/source_line_index';
import {Array as EffectArray} from 'effect';

const sourceArbitrary = FC.array(
  FC.oneof(FC.string({maxLength: 12}), FC.constantFrom('\n', '\r', '\r\n', '\u2028', '\u2029', '🙂', '\u0000')),
  {maxLength: 48},
).map(parts => EffectArray.join(parts, ''));

describe('code graph source line index properties', () => {
  fcProp(
    it,
    'matches the linear UTF-16 position reference for every newline form',
    {source: sourceArbitrary},
    ({source}) => {
      const index = createSourceLineIndex(source);
      for (let offset = 0; offset <= source.length; offset += 1) {
        expect(sourcePositionAt(index, offset)).toEqual(referencePosition(source, offset));
      }
    },
    {fastCheck: {numRuns: 500}},
  );
});

function referencePosition(content: string, offset: number): {readonly column: number; readonly line: number} {
  let column = 1;
  let cursor = 0;
  let line = 1;
  while (cursor < offset) {
    const width = lineTerminatorWidth(content, cursor);
    if (width > 0) {
      cursor += width;
      column = 1;
      line += 1;
    } else {
      cursor += 1;
      column += 1;
    }
  }
  return {column, line};
}

function lineTerminatorWidth(content: string, offset: number): number {
  const character = content[offset];
  if (character === '\r') return content[offset + 1] === '\n' ? 2 : 1;
  return character === '\n' || character === '\u2028' || character === '\u2029' ? 1 : 0;
}
