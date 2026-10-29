import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export class ManagerRequestInputError extends Schema.TaggedError<
  ManagerRequestInputError,
  {readonly brand: unique symbol}
>()('ManagerRequestInputError', {
  cause: Schema.optionalKey(Schema.Defect()),
  message: Schema.String,
}) {}
export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || Effect.pipe(value, EffectString.trim).length === 0) {
    throw ManagerRequestInputError.make({message: `Provide ${name}.`});
  }
  return value;
}
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && Effect.pipe(value, EffectString.trim).length > 0 ? value : undefined;
}
export function requireStringArray(value: unknown, name: string): readonly string[] {
  if (
    !EffectArray.isArray(value) ||
    value.length === 0 ||
    !EffectArray.every(value, item => typeof item === 'string')
  ) {
    throw ManagerRequestInputError.make({message: `Provide ${name} as a non-empty string array.`});
  }
  return value;
}
export function requireConfirm(body: Record<string, unknown>): void {
  if (body.confirm !== true) throw ManagerRequestInputError.make({message: 'Set confirm=true for this action.'});
}
