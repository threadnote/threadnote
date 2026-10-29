import {describe, expect, it} from '@effect/vitest';
import {Array as EffectArray} from 'effect';
import * as FC from 'fast-check';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {CodeGraphFactValidationError, parseCodeGraphFileFacts} from '../../src/fact/validation.js';

function hasNativeControlCode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Independent UTF-16 oracle for the allocation-free control-character check.
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function facts(id: string) {
  return {
    diagnostics: [],
    edges: [],
    path: 'src/fact.ts',
    symbols: [
      {
        contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        exported: true,
        id,
        kind: 'function',
        language: 'typescript',
        name: 'example',
        path: 'src/fact.ts',
        qualifiedName: 'example',
        span: {column: 1, endColumn: 2, endLine: 1, line: 1},
      },
    ],
  };
}

describe('parser fact structural control characters', () => {
  fcProp(
    it,
    'preserves the UTF-16 validation contract without mutating facts',
    {
      units: FC.array(
        FC.oneof(
          FC.integer({min: 0, max: 0xffff}),
          FC.integer({min: 0, max: 0x1f}),
          FC.integer({min: 0x7f, max: 0x9f}),
        ),
        {maxLength: 64},
      ),
    },
    ({units}) => {
      const id =
        'x' +
        EffectArray.join(
          EffectArray.map(units, code => String.fromCharCode(code)),
          '',
        ) +
        'x';
      const input = facts(id);
      const before = structuredClone(input);
      if (hasNativeControlCode(id)) expect(() => parseCodeGraphFileFacts(input)).toThrow(CodeGraphFactValidationError);
      else expect(parseCodeGraphFileFacts(input).symbols[0]?.id).toBe(id);
      expect(input).toEqual(before);
    },
    {fastCheck: {numRuns: 100}},
  );

  it('keeps range boundaries, unpaired surrogates and supplementary characters distinct', () => {
    for (const code of [0, 0x1f, 0x7f, 0x9f]) {
      expect(() => parseCodeGraphFileFacts(facts('x' + String.fromCharCode(code) + 'x'))).toThrow(
        CodeGraphFactValidationError,
      );
    }
    for (const code of [0x20, 0x7e, 0xa0, 0xd800, 0xdfff]) {
      const id = 'x' + String.fromCharCode(code) + 'x';
      expect(parseCodeGraphFileFacts(facts(id)).symbols[0]?.id).toBe(id);
    }
    expect(parseCodeGraphFileFacts(facts('x🙂x')).symbols[0]?.id).toBe('x🙂x');
  });
});
