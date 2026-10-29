import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {identifiers, indexTerms} from '@threadnote/recall/index/lexical';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

describe('recall tokenization', () => {
  it('keeps Ukrainian words and splits apostrophe and hyphen compounds', () => {
    expect(indexTerms('Пам’ять про Київ-2026')).toEqual(["пам'ять", 'пам', 'ять', 'про', 'київ-2026', 'київ', '2026']);
  });

  fcProp(
    it,
    'is invariant under canonical Unicode composition',
    {
      parts: FC.array(FC.constantFrom('Київ', 'пам’ять', 'надійний', 'європейський-2026'), {
        maxLength: 16,
      }),
    },
    ({parts}) => {
      const value = EffectArray.join(parts, ' ');
      expect(indexTerms(Effect.pipe(value, EffectString.normalize('NFD')))).toEqual(
        indexTerms(Effect.pipe(value, EffectString.normalize('NFC'))),
      );
    },
    {fastCheck: {numRuns: 100}},
  );

  it('keeps Unicode identifier values bounded', () => {
    const values = EffectArray.join(
      Array.from({length: 100}, (_, index) => `Київ-${index}`),
      ' ',
    );
    const indexed = identifiers(values);
    expect(indexed).toHaveLength(64);
    expect(indexed[0]).toBe('київ-0');
    expect(EffectArray.every(indexed, identifier => /[\p{N}_.-]/u.test(identifier))).toBe(true);
  });
});
