import {describe, expect, it} from '@effect/vitest';
import {fcProp} from '@threadnote/testing/fast-check-property';
import * as FC from 'fast-check';
import {isReadonlyArray} from '../../src/readonly-array.js';

interface Item {
  readonly id: string;
}

// This return type also checks that the guard retains Item rather than narrowing to unknown[].
const firstId = (value: ReadonlyArray<Item> | undefined): string | undefined =>
  isReadonlyArray(value) ? value[0]?.id : undefined;

describe('readonly array candidates', () => {
  fcProp(
    it,
    'matches the native array decision without changing readonly values',
    {value: FC.option(FC.array(FC.record({id: FC.string()}), {maxLength: 20}), {nil: undefined})},
    ({value}) => {
      const candidate = value === undefined ? undefined : Object.freeze(value);
      const before = candidate;
      // oxlint-disable-next-line effecttsgo/prefer-effect-array -- Independent native oracle for the readonly adapter.
      expect(isReadonlyArray(candidate)).toBe(Array.isArray(candidate));
      expect(candidate).toBe(before);
      expect(firstId(candidate)).toBe(candidate?.[0]?.id);
      expect(isReadonlyArray(null)).toBe(false);
    },
  );

  it('retains mutability when the input was already a mutable array', () => {
    const append = (value: Item[] | undefined) => {
      if (isReadonlyArray(value)) value.push({id: 'next'});
    };
    const value: Item[] = [];
    append(value);
    expect(value).toEqual([{id: 'next'}]);
  });
});
