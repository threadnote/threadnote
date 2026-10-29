import {Array as EffectArray, Schema} from 'effect';
import * as EffectRecord from 'effect/Record';

const isJsonRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

export function flattenJsonSchemaConstraints(value: unknown): unknown {
  if (EffectArray.isArray(value)) return EffectArray.map(value, flattenJsonSchemaConstraints);
  if (!isJsonRecord(value)) return value;
  const output = EffectRecord.fromEntries(
    EffectArray.map(EffectRecord.toEntries(value), ([key, entry]) => [key, flattenJsonSchemaConstraints(entry)]),
  );
  const constraints = output.allOf;
  if (!EffectArray.isArray(constraints)) return output;
  const merged: Record<string, unknown> = {};
  for (const constraint of constraints) {
    if (!isJsonRecord(constraint)) return output;
    for (const [key, entry] of EffectRecord.toEntries(constraint)) {
      const hasPrevious = EffectRecord.has(merged, key) || EffectRecord.has(output, key);
      const previous = EffectRecord.has(merged, key) ? merged[key] : output[key];
      if (hasPrevious && JSON.stringify(previous) !== JSON.stringify(entry)) {
        if (
          (key === 'minimum' || key === 'maximum') &&
          typeof previous === 'number' &&
          Number.isFinite(previous) &&
          typeof entry === 'number' &&
          Number.isFinite(entry)
        ) {
          merged[key] = key === 'minimum' ? Math.max(previous, entry) : Math.min(previous, entry);
          continue;
        }
        return output;
      }
      merged[key] = entry;
    }
  }
  delete output.allOf;
  return Object.assign(output, merged);
}
