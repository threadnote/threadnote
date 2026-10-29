import * as EffectString from 'effect/String';
import * as Effect from 'effect';
export function uriSegment(value: string): string {
  const replaced = Effect.pipe(value, EffectString.toLowerCase, EffectString.replace(/[^a-z0-9._-]+/g, '-'));
  let start = 0;
  while (replaced[start] === '-') start += 1;

  let end = replaced.length;
  while (end > start && replaced[end - 1] === '-') end -= 1;

  const normalized = Effect.pipe(replaced, EffectString.slice(start, end));
  return normalized.length > 0 ? normalized : 'unknown';
}
