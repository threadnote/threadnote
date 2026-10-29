import {Array as EffectArray} from 'effect';
import {Predicate} from 'effect';
import * as EffectRecord from 'effect/Record';

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) invalid(`${label} must be an object`);
  return value;
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = EffectRecord.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || EffectArray.some(actual, (key, index) => key !== expected[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

export function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

export function matchingString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  return value;
}

export function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed < 1) invalid(`${label} must be a positive integer`);
  return parsed;
}

export function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative integer`);
  }
  return value;
}

export function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

export function assertCanonicalOrder(values: readonly string[], label: string): void {
  if (EffectArray.some(values, (value, index) => value !== [...values].sort()[index]))
    invalid(`${label} must be sorted canonically`);
}

export function armPosition(value: unknown): 1 | 2 | 3 {
  if (value !== 1 && value !== 2 && value !== 3) invalid('arm position must be 1, 2, or 3');
  return value;
}

export function invalid(message: string): never {
  throw new Error(`Invalid Code Memory Link agent A/B evidence: ${message}.`);
}
