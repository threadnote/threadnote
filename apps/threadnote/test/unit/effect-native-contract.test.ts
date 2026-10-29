import {Array as EffectArray, Option, Record as EffectRecord, String as EffectString} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import * as FC from 'fast-check';
import {describe, expect, it} from '@effect/vitest';

describe('native contracts preserved by the Effect migration', () => {
  fcProp(
    it,
    'preserves sparse array traversal for native-backed Effect operations',
    {values: FC.array(FC.integer(), {maxLength: 24}), holes: FC.array(FC.nat(23), {maxLength: 24})},
    ({values, holes}) => {
      const sparse = [...values];
      for (const index of holes) if (index < sparse.length) delete sparse[index];
      const map = (value: number | undefined, index: number) => `${index}:${value ?? 'missing'}`;
      const predicate = (value: number | undefined) => value !== undefined && value > 0;
      const reduce = (sum: number, value: number | undefined, index: number) => sum + (value ?? 0) + index;
      // oxlint-disable-next-line effecttsgo/prefer-effect-array -- Native methods are independent before-migration oracles.
      expect(EffectArray.map(sparse, map)).toStrictEqual(sparse.map(map));
      // oxlint-disable-next-line effecttsgo/prefer-effect-array -- Preserve native sparse traversal, not only dense examples.
      expect(EffectArray.some(sparse, predicate)).toBe(sparse.some(predicate));
      // oxlint-disable-next-line effecttsgo/prefer-effect-array -- Independent native oracle for all visited values.
      expect(EffectArray.every(sparse, predicate)).toBe(sparse.every(predicate));
      // oxlint-disable-next-line effecttsgo/prefer-effect-array -- Independent native oracle for accumulator and index order.
      expect(EffectArray.reduce(sparse, 0, reduce)).toBe(sparse.reduce(reduce, 0));
    },
  );

  fcProp(
    it,
    'preserves sparse native filtering for the pure Boolean predicate',
    {
      values: FC.array(FC.option(FC.integer(), {nil: undefined}), {maxLength: 24}),
      holes: FC.array(FC.nat(23), {maxLength: 24}),
    },
    ({values, holes}) => {
      const sparse = [...values];
      for (const index of holes) if (index < sparse.length) delete sparse[index];
      expect(EffectArray.filter(sparse, Boolean)).toStrictEqual(
        // oxlint-disable-next-line effecttsgo/prefer-effect-array -- Native Boolean filtering is the independent sparse-array oracle.
        sparse.filter(Boolean),
      );
      const sparsePredicate = (value: number | undefined, index: number) =>
        value !== undefined && (value + index) % 2 === 0;
      expect(
        EffectArray.filter(sparse, (value, index) => index in sparse && sparsePredicate(value, index)),
      ).toStrictEqual(
        // oxlint-disable-next-line effecttsgo/prefer-effect-array -- Native sparse filtering is the independent oracle for the presence guard.
        sparse.filter(sparsePredicate),
      );
      const holeSensitivePredicate = (value: number | undefined, index: number) =>
        value === undefined ? index % 2 === 0 : (value + index) % 3 !== 0;
      expect(EffectArray.some(sparse, (value, index) => index in sparse && holeSensitivePredicate(value, index))).toBe(
        // oxlint-disable-next-line effecttsgo/prefer-effect-array -- Native some skips holes while retaining present undefined values.
        sparse.some(holeSensitivePredicate),
      );
      expect(
        EffectArray.every(sparse, (value, index) => !(index in sparse) || holeSensitivePredicate(value, index)),
      ).toBe(
        // oxlint-disable-next-line effecttsgo/prefer-effect-array -- Native every skips holes while retaining present undefined values.
        sparse.every(holeSensitivePredicate),
      );
    },
  );

  fcProp(
    it,
    'preserves find sentinels for pure predicates over dense collections',
    {values: FC.array(FC.option(FC.integer(), {nil: undefined}), {maxLength: 24}), target: FC.integer()},
    ({values, target}) => {
      const predicate = (value: number | undefined) => value === target;
      // oxlint-disable-next-line effecttsgo/prefer-effect-array -- Native undefined sentinel is the migration oracle.
      expect(Option.getOrUndefined(EffectArray.findFirst(values, predicate))).toBe(values.find(predicate));
      expect(Option.getOrElse(EffectArray.findFirstIndex(values, predicate), () => -1)).toBe(
        // oxlint-disable-next-line effecttsgo/prefer-effect-array -- Native -1 sentinel is the migration oracle.
        values.findIndex(predicate),
      );
    },
  );

  fcProp(
    it,
    'preserves string results and search sentinels for equivalent operations',
    {
      text: FC.string({maxLength: 80}),
      search: FC.string({maxLength: 8}),
      start: FC.integer({min: -100, max: 100}),
      end: FC.integer({min: -100, max: 100}),
      count: FC.integer({min: 0, max: 5}),
    },
    ({text, search, start, end, count}) => {
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Independent native oracle for curried slice arguments.
      expect(EffectString.slice(start, end)(text)).toBe(text.slice(start, end));
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Independent native whitespace oracle.
      expect(EffectString.trim(text)).toBe(text.trim());
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Repeat is equivalent only for bounded nonnegative integers.
      expect(EffectString.repeat(count)(text)).toBe(text.repeat(count));
      // oxlint-disable-next-line effecttsgo/prefer-effect-string -- Preserve the native missing-search sentinel.
      expect(Option.getOrElse(EffectString.indexOf(search)(text), () => -1)).toBe(text.indexOf(search));
    },
  );

  fcProp(
    it,
    'preserves own entries and order for plain data records',
    {record: FC.dictionary(FC.string({maxLength: 10}), FC.integer())},
    ({record}) => {
      // oxlint-disable-next-line effecttsgo/prefer-effect-record -- Plain-data native keys are the independent migration oracle.
      expect(EffectRecord.keys(record)).toEqual(Object.keys(record));
      // oxlint-disable-next-line effecttsgo/prefer-effect-record -- Plain-data native values are the independent migration oracle.
      expect(EffectRecord.values(record)).toEqual(Object.values(record));
      // oxlint-disable-next-line effecttsgo/prefer-effect-record -- Getter/proxy mutation is deliberately outside the plain-data contract.
      expect(EffectRecord.toEntries(record)).toEqual(Object.entries(record));
      expect(EffectRecord.fromEntries(EffectRecord.toEntries(record))).toEqual(record);
    },
  );
});
