import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import * as EffectRecord from 'effect/Record';
export type CanonicalJsonPrimitive = boolean | null | number | string;
export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}
export type CanonicalJsonValue = CanonicalJsonPrimitive | readonly CanonicalJsonValue[] | CanonicalJsonObject;

export interface CanonicalJsonLimits {
  readonly maximumContainerEntries: number;
  readonly maximumDepth: number;
  readonly maximumInputCodeUnits: number;
  readonly maximumStringCodeUnits: number;
}

export const DEFAULT_CANONICAL_JSON_LIMITS: CanonicalJsonLimits = {
  maximumContainerEntries: 1_000_000,
  maximumDepth: 64,
  maximumInputCodeUnits: 16 * 1_048_576,
  maximumStringCodeUnits: 8 * 1_048_576,
};

export class CanonicalJsonError extends Schema.TaggedError<CanonicalJsonError, {readonly brand: unique symbol}>()(
  'CanonicalJsonError',
  {
    cause: Schema.optionalKey(Schema.Defect()),
    message: Schema.String,
  },
) {}

/**
 * RFC 8785 JSON Canonicalization Scheme serialization for the I-JSON data
 * model used by checkpoints. JavaScript's primitive serializer supplies the
 * specified ECMAScript number and string spelling; this traversal supplies
 * strict input validation and UTF-16 property ordering.
 */
export function canonicalJson(value: unknown, limits: Partial<CanonicalJsonLimits> = {}): string {
  const resolved = resolveLimits(limits);
  const ancestors = new Set<object>();
  let entries = 0;

  const visitString = (value: string, label: string): string => {
    if (value.length > resolved.maximumStringCodeUnits) {
      throw CanonicalJsonError.make({message: `${label} exceeds the canonical JSON string limit.`});
    }
    ensureUnicodeScalarString(value, label);
    return JSON.stringify(value);
  };

  const visit = (current: unknown, depth: number): string => {
    if (depth > resolved.maximumDepth) {
      throw CanonicalJsonError.make({message: 'Canonical JSON exceeds the maximum nesting depth.'});
    }
    if (current === null) return 'null';
    switch (typeof current) {
      case 'boolean':
        return current ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(current)) {
          throw CanonicalJsonError.make({message: 'Canonical JSON numbers must be finite IEEE-754 values.'});
        }
        return JSON.stringify(current);
      case 'string':
        return visitString(current, 'Canonical JSON string');
      case 'object':
        break;
      default:
        throw CanonicalJsonError.make({message: `Canonical JSON does not support ${typeof current} values.`});
    }

    if (ancestors.has(current)) throw CanonicalJsonError.make({message: 'Canonical JSON cannot contain cycles.'});
    ancestors.add(current);
    try {
      if (EffectArray.isArray(current)) {
        entries = checkedEntryTotal(entries, current.length, resolved.maximumContainerEntries);
        const ownKeys = Reflect.ownKeys(current);
        const expectedKeys = new Set<string>(['length']);
        for (let index = 0; index < current.length; index += 1) expectedKeys.add(String(index));
        for (const key of ownKeys) {
          if (typeof key === 'symbol' || !expectedKeys.has(key)) {
            throw CanonicalJsonError.make({message: 'Canonical JSON arrays cannot contain extra own properties.'});
          }
        }
        const values: string[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor?.enumerable || !('value' in descriptor)) {
            throw CanonicalJsonError.make({message: 'Canonical JSON array slots must be enumerable data properties.'});
          }
          values.push(visit(descriptor.value, depth + 1));
        }
        return `[${EffectArray.join(values, ',')}]`;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw CanonicalJsonError.make({message: 'Canonical JSON objects must have a plain or null prototype.'});
      }
      const ownKeys = Reflect.ownKeys(current);
      if (EffectArray.some(ownKeys, key => typeof key === 'symbol')) {
        throw CanonicalJsonError.make({message: 'Canonical JSON objects cannot contain symbol keys.'});
      }
      const keys = EffectArray.filter(ownKeys, (key): key is string => typeof key === 'string');
      entries = checkedEntryTotal(entries, keys.length, resolved.maximumContainerEntries);
      const properties: string[] = [];
      for (const key of keys.sort(compareCodeUnits)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw CanonicalJsonError.make({
            message: 'Canonical JSON objects may contain only enumerable data properties.',
          });
        }
        properties.push(`${visitString(key, 'Canonical JSON property name')}:${visit(descriptor.value, depth + 1)}`);
      }
      return `{${EffectArray.join(properties, ',')}}`;
    } finally {
      ancestors.delete(current);
    }
  };

  const rendered = visit(value, 0);
  if (rendered.length > resolved.maximumInputCodeUnits) {
    throw CanonicalJsonError.make({message: 'Canonical JSON output exceeds the input limit.'});
  }
  return rendered;
}

/** Parse only the single RFC 8785 spelling accepted by {@link canonicalJson}. */
export function parseCanonicalJson(value: string, limits: Partial<CanonicalJsonLimits> = {}): CanonicalJsonValue {
  const resolved = resolveLimits(limits);
  if (value.length > resolved.maximumInputCodeUnits) {
    throw CanonicalJsonError.make({message: 'Canonical JSON input exceeds the input limit.'});
  }
  ensureUnicodeScalarString(value, 'Canonical JSON input');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (cause) {
    throw CanonicalJsonError.make({message: cause instanceof Error ? cause.message : 'Canonical JSON is malformed.'});
  }
  const rendered = canonicalJson(parsed, resolved);
  if (rendered !== value) throw CanonicalJsonError.make({message: 'JSON input is not in RFC 8785 canonical form.'});
  if (!isCanonicalJsonValue(parsed))
    throw CanonicalJsonError.make({message: 'JSON input contains an unsupported value.'});
  return parsed;
}

function isCanonicalJsonValue(value: unknown): value is CanonicalJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (EffectArray.isArray(value)) return EffectArray.every(value, isCanonicalJsonValue);
  return (
    typeof value === 'object' && value !== null && EffectArray.every(EffectRecord.values(value), isCanonicalJsonValue)
  );
}

function resolveLimits(overrides: Partial<CanonicalJsonLimits>): CanonicalJsonLimits {
  const limits = {...DEFAULT_CANONICAL_JSON_LIMITS, ...overrides};
  for (const [name, value] of EffectRecord.toEntries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw CanonicalJsonError.make({message: `${name} must be a non-negative safe integer.`});
    }
  }
  return limits;
}

function checkedEntryTotal(current: number, added: number, maximum: number): number {
  if (added > maximum - current) {
    throw CanonicalJsonError.make({message: 'Canonical JSON contains too many container entries.'});
  }
  return current + added;
}

const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

function ensureUnicodeScalarString(value: string, label: string): void {
  if (UNPAIRED_SURROGATE.test(value)) {
    throw CanonicalJsonError.make({message: `${label} contains a lone surrogate.`});
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
