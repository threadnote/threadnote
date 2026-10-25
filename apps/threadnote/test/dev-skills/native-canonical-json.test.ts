import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {makeRequestCanonicalJson} from '../../src/workflow_memory/canonical_json.js';
import {stableJson} from '../../src/workflow_memory/protocol.js';

function deepFreeze<A>(value: A, seen = new WeakSet<object>()): A {
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor) deepFreeze(descriptor.value, seen);
    }
    Object.freeze(value);
  }
  return value;
}

function errorName(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.name : typeof error;
  }
  return undefined;
}

describe('request canonical JSON fragments', () => {
  it('matches stableJson for bounded nested JSON, Unicode, integer-like keys, and insertion orders', () => {
    const canonicalJson = makeRequestCanonicalJson();
    fc.assert(
      fc.property(fc.jsonValue(), fc.boolean(), (generated, reverse) => {
        const entries: Array<[string, unknown]> = [
          ['10', generated],
          ['2', {text: 'café 🧭 日本語', optional: undefined}],
          ['01', [generated, undefined, null]],
          ['Ω', 'line\nquote"'],
        ];
        if (reverse) entries.reverse();
        const value = Object.fromEntries(entries);
        expect(canonicalJson(value)).toBe(stableJson(value));
        const sparse = Object.assign(new Array(4), {0: value, 1: undefined, 3: '🧭'});
        expect(canonicalJson(sparse)).toBe(stableJson(sparse));
      }),
      {numRuns: 100},
    );
    expect(canonicalJson(undefined)).toBe(stableJson(undefined));
  });

  it('reuses frozen historical operation fragments across append and replacement transitions', () => {
    const canonicalJson = makeRequestCanonicalJson();
    const first = deepFreeze({
      id: 'operation-1',
      request: {body: 'First 🧭', relations: [{type: 'references', uri: 'threadnote://memory/one'}]},
      intentDigest: 'a'.repeat(64),
    });
    const second = deepFreeze({
      id: 'operation-2',
      request: {body: 'Second', relations: []},
      intentDigest: 'b'.repeat(64),
    });
    const replacement = deepFreeze({
      id: 'operation-3',
      request: {body: 'Replacement', relations: []},
      intentDigest: 'c'.repeat(64),
    });
    const initial = {operations: [first]};
    const appended = {operations: [first, second]};
    const replaced = {operations: [second, replacement]};
    for (const state of [initial, appended, replaced]) expect(canonicalJson(state)).toBe(stableJson(state));
  });

  it('reflects mutation in mutable and shallow-frozen parents', () => {
    const canonicalJson = makeRequestCanonicalJson();
    const mutable = {value: 1};
    expect(canonicalJson(mutable)).toBe(stableJson(mutable));
    mutable.value = 2;
    expect(canonicalJson(mutable)).toBe(stableJson(mutable));

    const nested = {value: 1};
    const shallowFrozen = Object.freeze({nested});
    expect(canonicalJson(shallowFrozen)).toBe(stableJson(shallowFrozen));
    nested.value = 2;
    expect(canonicalJson(shallowFrozen)).toBe(stableJson(shallowFrozen));
  });

  it('falls back for accessors and toJSON without caching their side effects', () => {
    const canonicalJson = makeRequestCanonicalJson();
    let getterCalls = 0;
    const accessor: {readonly value?: number} = {};
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => ++getterCalls,
    });
    Object.freeze(accessor);
    const firstAccessorResult = canonicalJson(accessor);
    expect(getterCalls).toBe(1);
    getterCalls = 0;
    expect(stableJson(accessor)).toBe(firstAccessorResult);
    expect(getterCalls).toBe(1);
    getterCalls = 0;
    const secondAccessorResult = canonicalJson(accessor);
    expect(getterCalls).toBe(1);
    getterCalls = 0;
    expect(stableJson(accessor)).toBe(secondAccessorResult);
    expect(getterCalls).toBe(1);

    let jsonCalls = 0;
    const withToJson = {
      value: 1,
      toJSON() {
        jsonCalls += 1;
        return {value: jsonCalls};
      },
    };
    Object.freeze(withToJson);
    const firstJsonResult = canonicalJson(withToJson);
    expect(jsonCalls).toBe(1);
    jsonCalls = 0;
    expect(stableJson(withToJson)).toBe(firstJsonResult);
    expect(jsonCalls).toBe(1);
    jsonCalls = 0;
    const secondJsonResult = canonicalJson(withToJson);
    expect(jsonCalls).toBe(1);
    jsonCalls = 0;
    expect(stableJson(withToJson)).toBe(secondJsonResult);
    expect(jsonCalls).toBe(1);
  });

  it('falls back after immutable fragments are cached if a built-in prototype gains toJSON', () => {
    const canonicalJson = makeRequestCanonicalJson();
    const frozenObject = deepFreeze({nested: {value: 'object'}});
    const frozenArray = deepFreeze([{value: 'array'}]);
    expect(canonicalJson(frozenObject)).toBe(stableJson(frozenObject));
    expect(canonicalJson(frozenArray)).toBe(stableJson(frozenArray));

    const cases = [
      {prototype: Object.prototype, value: frozenObject, result: 'object-prototype'},
      {prototype: Array.prototype, value: frozenArray, result: 'array-prototype'},
    ];
    for (const {prototype, value, result} of cases) {
      const previous = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
      let actual: string | undefined;
      let expected: string | undefined;
      try {
        Object.defineProperty(prototype, 'toJSON', {
          configurable: true,
          value: () => result,
        });
        actual = canonicalJson(value);
        expected = stableJson(value);
      } finally {
        if (previous) Object.defineProperty(prototype, 'toJSON', previous);
        else Reflect.deleteProperty(prototype, 'toJSON');
      }
      expect(actual).toBe(expected);
      expect(actual).toBe(JSON.stringify(result));
    }
  });

  it('does not cache sparse arrays that can observe inherited numeric slots', () => {
    const canonicalJson = makeRequestCanonicalJson();
    const sparse = Object.freeze(new Array(1));
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, '0');
    const values: string[] = [];
    try {
      Object.defineProperty(Array.prototype, '0', {configurable: true, writable: true, value: 'first'});
      values.push(canonicalJson(sparse), stableJson(sparse));
      Object.defineProperty(Array.prototype, '0', {configurable: true, writable: true, value: 'changed'});
      values.push(canonicalJson(sparse), stableJson(sparse));
    } finally {
      if (previous) Object.defineProperty(Array.prototype, '0', previous);
      else Reflect.deleteProperty(Array.prototype, '0');
    }
    expect(values).toEqual(['["first"]', '["first"]', '["changed"]', '["changed"]']);
  });

  it('keeps output equivalent after the per-request cache budget fills', () => {
    const canonicalJson = makeRequestCanonicalJson({maximumCachedBytes: 16});
    const values = Array.from({length: 8}, (_, index) =>
      deepFreeze({id: index, content: `large historical value ${index} 🧭`.repeat(4)}),
    );
    const state = {operations: values, current: {id: 'current', content: 'new'}};
    expect(canonicalJson(state)).toBe(stableJson(state));
    expect(canonicalJson(state)).toBe(stableJson(state));
  });

  it('preserves stableJson error classes for BigInt and cyclic input', () => {
    const canonicalJson = makeRequestCanonicalJson();
    const bigint = {value: 1n};
    expect(errorName(() => canonicalJson(bigint))).toBe(errorName(() => stableJson(bigint)));

    const cyclic: {self?: unknown} = {};
    cyclic.self = cyclic;
    expect(errorName(() => canonicalJson(cyclic))).toBe(errorName(() => stableJson(cyclic)));
  });
});
