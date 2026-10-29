import {Array as EffectArray} from 'effect';

/** Narrow an unknown value to one of the values checked at this boundary. */
export function isOneOf<const Values extends readonly unknown[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return EffectArray.some(values, candidate => candidate === value);
}

/** Number.isSafeInteger without requiring a narrowing assertion at callers. */
export function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}
