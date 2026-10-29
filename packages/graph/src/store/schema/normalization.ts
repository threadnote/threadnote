import {Array as EffectArray} from 'effect';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const normalizedDefinitions = new Map<string, string>();
const MAXIMUM_CACHED_DEFINITIONS = 128;
const MAXIMUM_CACHED_DEFINITION_CODE_UNITS = 16 * 1_024;
const MAXIMUM_CACHED_CODE_UNITS = 256 * 1_024;
let cachedCodeUnits = 0;

export function normalizeSchemaDefinition(value: string): string {
  const cached = normalizedDefinitions.get(value);
  if (cached !== undefined) return cached;
  const normalized = normalizeUncachedSchemaDefinition(value);
  const codeUnits = value.length + normalized.length;
  // Cache only this pure transformation. Callers still read every schema
  // observation, and changed SQL must match its own exact string key.
  if (codeUnits > MAXIMUM_CACHED_DEFINITION_CODE_UNITS) return normalized;
  while (
    normalizedDefinitions.size >= MAXIMUM_CACHED_DEFINITIONS ||
    cachedCodeUnits + codeUnits > MAXIMUM_CACHED_CODE_UNITS
  ) {
    const oldest = normalizedDefinitions.keys().next();
    if (oldest.done) break;
    cachedCodeUnits -= oldest.value.length + normalizedDefinitions.get(oldest.value)!.length;
    normalizedDefinitions.delete(oldest.value);
  }
  normalizedDefinitions.set(value, normalized);
  cachedCodeUnits += codeUnits;
  return normalized;
}

function normalizeUncachedSchemaDefinition(value: string): string {
  const quoted: string[] = [];
  let unquoted = '';
  for (let index = 0; index < value.length; index += 1) {
    const opener = value[index];
    const closer = opener === '[' ? ']' : opener;
    if (opener !== "'" && opener !== '"' && opener !== '`' && opener !== '[') {
      unquoted += opener;
      continue;
    }
    const start = index;
    for (index += 1; index < value.length; index += 1) {
      if (value[index] !== closer) continue;
      if (closer !== ']' && value[index + 1] === closer) {
        index += 1;
        continue;
      }
      break;
    }
    quoted.push(Effect.pipe(value, EffectString.slice(start, Math.min(index + 1, value.length))));
    unquoted += `\u0000${quoted.length - 1}\u0000`;
  }
  return EffectArray.join(
    EffectArray.map(
      Effect.pipe(
        unquoted,
        EffectString.toLowerCase,
        EffectString.replace(/\bif not exists\b/gu, ''),
        EffectString.replace(/\s+/gu, ' '),
        EffectString.replace(/\s*([(),])\s*/gu, '$1'),
        EffectString.trim,
        EffectString.split('\u0000'),
      ),
      (segment, index) => (index % 2 === 1 ? (quoted[Number(segment)] ?? '') : segment),
    ),
    '',
  );
}
