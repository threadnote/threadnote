import {stableJson} from './protocol.js';

const defaultCacheBytes = 64 * 1024 * 1024;
const minimumCachedTextLength = 1024;
const maximumCachedTexts = 4096;
const utf8 = new TextEncoder();

type ObjectLike = object;

/**
 * Creates a request-local canonical JSON encoder that reuses serialized
 * fragments for deeply immutable, plain JSON subtrees. The private storage text
 * table can also reuse exact primitive quotes against the same retained budget.
 */
export function makeRequestCanonicalJson(options: {readonly maximumCachedBytes?: number} = {}) {
  const requestedBudget = options.maximumCachedBytes ?? defaultCacheBytes;
  const maximumCachedBytes =
    Number.isFinite(requestedBudget) && requestedBudget >= 0
      ? Math.min(defaultCacheBytes, Math.floor(requestedBudget))
      : 0;
  const cachedJson = new WeakMap<ObjectLike, string>();
  const cachedTexts = new Map<string, string>();
  const provenImmutable = new WeakSet<ObjectLike>();

  const inspect = (value: unknown, active: WeakSet<ObjectLike>): boolean => {
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object') return false;

    const object = value;
    if (active.has(object)) return false;
    if (provenImmutable.has(object)) return true;
    active.add(object);
    try {
      const array = Array.isArray(object);
      const prototype = Object.getPrototypeOf(object);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
      if (Object.getOwnPropertySymbols(object).length > 0) return false;
      if (!array && Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')) return false;
      if (array && Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')) return false;

      let deeplyFrozen = Object.isFrozen(object);
      const names = Object.getOwnPropertyNames(object);
      if (array) {
        const length = (object as unknown[]).length;
        // Sparse arrays can observe mutable numeric properties on Array.prototype.
        if (names.length !== length + 1) return false;
        for (const name of names) {
          if (name === 'length') continue;
          const index = Number(name);
          if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== name) return false;
          const descriptor = Object.getOwnPropertyDescriptor(object, name);
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
          if (!inspect(descriptor.value, active)) return false;
          if (
            descriptor.value !== null &&
            typeof descriptor.value === 'object' &&
            !provenImmutable.has(descriptor.value)
          )
            deeplyFrozen = false;
          else if (
            descriptor.value !== null &&
            typeof descriptor.value === 'object' &&
            !Object.isFrozen(descriptor.value)
          )
            deeplyFrozen = false;
        }
      } else {
        for (const name of names) {
          const descriptor = Object.getOwnPropertyDescriptor(object, name);
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
          if (!inspect(descriptor.value, active)) return false;
          if (
            descriptor.value !== null &&
            typeof descriptor.value === 'object' &&
            !provenImmutable.has(descriptor.value)
          )
            deeplyFrozen = false;
          else if (
            descriptor.value !== null &&
            typeof descriptor.value === 'object' &&
            !Object.isFrozen(descriptor.value)
          )
            deeplyFrozen = false;
        }
      }
      if (deeplyFrozen) provenImmutable.add(object);
      return true;
    } catch {
      return false;
    } finally {
      active.delete(object);
    }
  };

  const cacheFrozen = (value: ObjectLike, json: string): string => {
    if (!cachedJson.has(value)) {
      const byteLength = utf8.encode(json).byteLength;
      if (byteLength <= maximumCachedBytes - retainedBytes) {
        cachedJson.set(value, json);
        retainedBytes += byteLength;
      }
    }
    return json;
  };
  let retainedBytes = 0;

  const quoteText = (value: string): string => {
    if (value.length < minimumCachedTextLength) return JSON.stringify(value);
    const cached = cachedTexts.get(value);
    if (cached !== undefined) return cached;
    const quoted = JSON.stringify(value);
    // Account for both UTF-16 strings and an entry allowance, not engine heap/RSS.
    const bytes = 2 * (value.length + quoted.length) + 128;
    if (cachedTexts.size < maximumCachedTexts && bytes <= maximumCachedBytes - retainedBytes) {
      cachedTexts.set(value, quoted);
      retainedBytes += bytes;
    }
    return quoted;
  };

  const encode = (value: unknown, textValues = false): string => {
    const inheritedToJson = [Object.prototype, Array.prototype].some(prototype => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
      return descriptor !== undefined && (!('value' in descriptor) || typeof descriptor.value === 'function');
    });
    if (inheritedToJson) return stableJson(value);
    if (value === undefined) return stableJson(value);
    if (!inspect(value, new WeakSet())) return stableJson(value);

    const serialize = (current: unknown, active: WeakSet<ObjectLike>): string => {
      if (current === null) return 'null';
      if (typeof current === 'string') return textValues ? quoteText(current) : JSON.stringify(current);
      if (typeof current === 'boolean') return JSON.stringify(current);
      if (typeof current === 'number') return JSON.stringify(current);
      if (current === undefined) return 'null';
      if (typeof current !== 'object') return stableJson(current);

      const object = current;
      const cached = cachedJson.get(object);
      if (cached !== undefined) return cached;
      if (provenImmutable.has(object)) return cacheFrozen(object, stableJson(object));
      if (active.has(object)) return stableJson(value);
      active.add(object);
      try {
        if (Array.isArray(object)) {
          const parts = Array.from({length: object.length}, (_, index) => {
            const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
            if (!descriptor) return 'null';
            return serialize(descriptor.value, active);
          });
          return `[${parts.join(',')}]`;
        }

        const entries = Object.entries(object as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
        const lexicallySortedKeys = Object.fromEntries(entries.map(([key]) => [key, true]));
        const orderedKeys = Object.keys(lexicallySortedKeys);
        const values = new Map(entries);
        return `{${orderedKeys.map(key => `${JSON.stringify(key)}:${serialize(values.get(key), active)}`).join(',')}}`;
      } finally {
        active.delete(object);
      }
    };

    return serialize(value, new WeakSet());
  };

  return Object.assign((value: unknown) => encode(value), {
    // Disabled storage formatting stays a single native bulk call.
    textValues: maximumCachedBytes === 0 ? stableJson : (value: unknown) => encode(value, true),
  });
}
