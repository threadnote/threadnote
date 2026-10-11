export function flattenJsonSchemaConstraints(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(flattenJsonSchemaConstraints);
  if (typeof value !== 'object' || value === null) return value;
  const output = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, flattenJsonSchemaConstraints(entry)]),
  );
  const constraints = output.allOf;
  if (!Array.isArray(constraints)) return output;
  const merged: Record<string, unknown> = {};
  for (const constraint of constraints) {
    if (typeof constraint !== 'object' || constraint === null || Array.isArray(constraint)) return output;
    for (const [key, entry] of Object.entries(constraint)) {
      const hasPrevious = Object.hasOwn(merged, key) || Object.hasOwn(output, key);
      const previous = Object.hasOwn(merged, key) ? merged[key] : output[key];
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
