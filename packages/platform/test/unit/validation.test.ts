import {describe, expect, it} from '@effect/vitest';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {Array as EffectArray} from 'effect';
import * as FC from 'fast-check';
import {isFiniteNumber, isInteger, isOneOf, isSafeInteger} from '../../src/validation.js';

describe('checked primitive values', () => {
  fcProp(it, 'narrows numeric values without coercion', {value: FC.oneof(FC.anything(), FC.double())}, ({value}) => {
    const finite = typeof value === 'number' && value === value && value !== Infinity && value !== -Infinity;
    const integer = finite && Math.trunc(value) === value;
    expect(isFiniteNumber(value)).toBe(finite);
    expect(isInteger(value)).toBe(integer);
    expect(isSafeInteger(value)).toBe(integer && Math.abs(value) <= Number.MAX_SAFE_INTEGER);
  });

  fcProp(
    it,
    'membership follows SameValueZero without mutating the input',
    {
      values: FC.array(FC.oneof(FC.double(), FC.string(), FC.constant(undefined), FC.constant(null)), {maxLength: 20}),
      value: FC.oneof(FC.double(), FC.string(), FC.constant(undefined), FC.constant(null)),
    },
    ({values, value}) => {
      const frozen = Object.freeze(values);
      const expected = EffectArray.some(values, candidate => candidate === value || Object.is(candidate, value));
      expect(isOneOf(frozen, value)).toBe(expected);
      expect(values).toEqual(frozen);
    },
  );

  it('retains unvalidated numbers in a numeric false branch', () => {
    const describeNumber = (value: number): string => (isFiniteNumber(value) ? 'finite' : value.toString());
    expect(describeNumber(Infinity)).toBe('Infinity');
    expect(describeNumber(NaN)).toBe('NaN');
    expect(isOneOf([NaN, 0] as const, NaN)).toBe(true);
    expect(isOneOf([NaN, 0] as const, -0)).toBe(true);
    let coercions = 0;
    const value = {
      valueOf: () => {
        coercions += 1;
        return 1;
      },
    };
    expect(isSafeInteger(value)).toBe(false);
    expect(isFiniteNumber(value)).toBe(false);
    expect(isInteger(value)).toBe(false);
    expect(coercions).toBe(0);
  });
});
