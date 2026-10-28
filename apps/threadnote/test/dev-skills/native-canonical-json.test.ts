import fc from 'fast-check';
import {describe, expect, it, vi} from 'vitest';
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

  it('matches native table bytes across requests, mutation, Unicode, and disabled budgets', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({min: 0, max: 0xffff}), {minLength: 1, maxLength: 48}),
        fc.constantFrom(0, -1, Number.NaN, Number.POSITIVE_INFINITY, 4228, 64 * 1024 * 1024),
        (units, maximumCachedBytes) => {
          const text = String.fromCharCode(...units).repeat(1024);
          const table = [text, text + '\n"\\🙂\ud800'];
          const encoder = makeRequestCanonicalJson({maximumCachedBytes});
          for (const values of [table, [...table], Object.freeze([...table])]) {
            expect(encoder.textValues(values)).toBe(stableJson(values));
          }
          table[0] = 'x' + text.slice(1);
          expect(encoder.textValues(table)).toBe(stableJson(table));
          expect(makeRequestCanonicalJson().textValues(table)).toBe(stableJson(table));
        },
      ),
      {numRuns: 24},
    );
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(makeRequestCanonicalJson({maximumCachedBytes: budget}).textValues).toBe(stableJson);
    }
  });

  it('shares one retained ledger with populated frozen fragments in both admission orders', () => {
    for (const text of ['x'.repeat(1024), '"\\\n雪🙂\ud800'.repeat(160)]) {
      const frozen = deepFreeze({payload: 'frozen snow 雪'});
      const frozenBytes = new TextEncoder().encode(stableJson(frozen)).byteLength;
      const textBytes = 2 * (text.length + JSON.stringify(text).length) + 128;
      for (const textFirst of [false, true]) {
        for (const delta of [-1, 0, 1]) {
          const encoder = makeRequestCanonicalJson({maximumCachedBytes: frozenBytes + textBytes + delta});
          const native = vi.spyOn(JSON, 'stringify');
          let calls: {frozen: number; text: number};
          try {
            const encodeText = () => encoder.textValues([text]);
            const encodeFrozen = () => encoder(frozen);
            const steps = textFirst ? [encodeText, encodeFrozen] : [encodeFrozen, encodeText];
            for (const step of [...steps, ...steps]) step();
            calls = {
              frozen: native.mock.calls.filter(([value]) => typeof value === 'object').length,
              text: native.mock.calls.filter(([value]) => value === text).length,
            };
          } finally {
            native.mockRestore();
          }
          expect(calls).toEqual({
            frozen: delta >= 0 || !textFirst ? 1 : 2,
            text: delta >= 0 || textFirst ? 1 : 2,
          });
        }
      }
    }
  });

  it('bounds exact text retention, preserves saturation hits, and leaves generic/frozen formatting native', () => {
    const short = 's'.repeat(1023);
    const first = 'a'.repeat(1024);
    const next = 'b'.repeat(1024);
    const charge = 2 * (first.length + JSON.stringify(first).length) + 128;
    const encoder = makeRequestCanonicalJson({maximumCachedBytes: charge});
    const native = vi.spyOn(JSON, 'stringify');
    let counts: number[];
    try {
      encoder.textValues([short, first, next]);
      encoder.textValues([short, first, next]);
      counts = [short, first, next].map(text => native.mock.calls.filter(([value]) => value === text).length);
      native.mockClear();
      encoder({text: first});
      encoder.textValues(Object.freeze([first]));
      expect(native.mock.calls.some(([value]) => Array.isArray(value))).toBe(true);
      expect(native.mock.calls.filter(([value]) => value === first)).toHaveLength(1);
    } finally {
      native.mockRestore();
    }
    expect(counts).toEqual([2, 1, 2]);

    const texts = Array.from({length: 4098}, (_, index) => `${index}:` + 'x'.repeat(1024));
    const capped = makeRequestCanonicalJson();
    expect(capped.textValues(texts)).toBe(stableJson(texts));
    const cappedNative = vi.spyOn(JSON, 'stringify');
    let quoted: unknown[];
    try {
      capped.textValues(texts);
      quoted = cappedNative.mock.calls.map(([value]) => value);
    } finally {
      cappedNative.mockRestore();
    }
    expect(quoted).toEqual(texts.slice(4096));
    const oversize = makeRequestCanonicalJson({maximumCachedBytes: charge - 1});
    expect(oversize.textValues([first, first])).toBe(stableJson([first, first]));
  });

  it('checks warmed table hooks before hits and preserves throwing/reentrant call order', () => {
    const text = 'quoted\n"\\雪🙂\ud800'.repeat(128);
    const encoder = makeRequestCanonicalJson();
    encoder.textValues([text]);
    for (const prototype of [Object.prototype, Array.prototype]) {
      for (const accessor of [false, true]) {
        for (const throwing of [false, true]) {
          const previous = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
          const run = (format: (value: unknown) => string) => {
            const events: string[] = [];
            let reentrant = false;
            const hook = () => {
              events.push('hook');
              if (throwing) throw new RangeError('table hook');
              if (!reentrant) {
                reentrant = true;
                events.push(encoder.textValues([text]));
                reentrant = false;
              }
              return 'hook-result';
            };
            try {
              Object.defineProperty(prototype, 'toJSON', {
                configurable: true,
                ...(accessor
                  ? {
                      get: () => {
                        events.push('get');
                        if (throwing) throw new RangeError('table getter');
                        return hook;
                      },
                    }
                  : {value: hook}),
              });
              try {
                return {output: format([text]), events};
              } catch (error) {
                return {error: error instanceof Error ? [error.name, error.message] : error, events};
              }
            } finally {
              if (previous) Object.defineProperty(prototype, 'toJSON', previous);
              else Reflect.deleteProperty(prototype, 'toJSON');
            }
          };
          expect(run(encoder.textValues)).toEqual(run(stableJson));
        }
      }
    }
    const accessorTable = [text];
    Object.defineProperty(accessorTable, '0', {
      get: () => {
        throw new SyntaxError('first getter');
      },
    });
    const unsupported: unknown[] = [accessorTable, [1n], {self: undefined}, Object.assign(new Array(2), {1: text})];
    unsupported[2] = unsupported;
    for (const value of unsupported) {
      expect(errorName(() => encoder.textValues(value))).toBe(errorName(() => stableJson(value)));
    }
    const exotic = Object.assign(new String(text), {toJSON: () => 'boxed'});
    expect(encoder.textValues([exotic])).toBe(stableJson([exotic]));
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
