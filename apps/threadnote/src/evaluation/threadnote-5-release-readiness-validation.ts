import {
  isFiniteNumber as checkedIsFiniteNumber,
  isSafeInteger as checkedIsSafeInteger,
} from '@threadnote/platform/validation';
import {Array as EffectArray, Predicate} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const source = object(value, label);
  if (canonicalJson(EffectRecord.keys(source).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
  return source;
}

export function allowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return EffectArray.every(EffectRecord.keys(value), key => set.has(key));
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!Predicate.isObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

export function boundedArray(value: unknown, label: string, minimum: number, maximum: number): readonly unknown[] {
  if (!EffectArray.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum} to ${maximum} entries.`);
  }
  return value;
}

export function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

export function hashText(value: unknown, label: string): string {
  if (!hash(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

export function nonEmptyText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && Effect.pipe(value, EffectString.trim).length > 0 && value.length <= maximum;
}

export function text(value: unknown, label: string, maximum: number): string {
  if (!nonEmptyText(value, maximum)) throw new Error(`${label} must be bounded non-empty text.`);
  return value;
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isoInstant(value: unknown): value is string {
  return (
    typeof value === 'string' && checkedIsFiniteNumber(Date.parse(value)) && new Date(value).toISOString() === value
  );
}

export function integerIn(value: unknown, minimum: number, maximum: number): value is number {
  return checkedIsSafeInteger(value) && value >= minimum && value <= maximum;
}
