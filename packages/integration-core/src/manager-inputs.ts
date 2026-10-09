import {Schema} from 'effect';
export class ManagerRequestInputError extends Schema.TaggedError<ManagerRequestInputError>()(
  'ManagerRequestInputError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}
export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ManagerRequestInputError.make({message: `Provide ${name}.`});
  }
  return value;
}
export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
export function requireStringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string')) {
    throw ManagerRequestInputError.make({message: `Provide ${name} as a non-empty string array.`});
  }
  return value;
}
export function requireConfirm(body: Record<string, unknown>): void {
  if (body.confirm !== true) throw ManagerRequestInputError.make({message: 'Set confirm=true for this action.'});
}
