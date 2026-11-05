import {expect, it} from 'vitest';
import {runtimeIsProxy} from '../src/system.js';

it('detects proxies without invoking their traps', () => {
  let traps = 0;
  const proxy = new Proxy(
    {},
    {
      get: () => {
        traps++;
        return undefined;
      },
      getOwnPropertyDescriptor: () => {
        traps++;
        return undefined;
      },
      getPrototypeOf: () => {
        traps++;
        return Object.prototype;
      },
      ownKeys: () => {
        traps++;
        return [];
      },
    },
  );

  expect(runtimeIsProxy(proxy)).toBe(true);
  expect(runtimeIsProxy({})).toBe(false);
  expect(runtimeIsProxy(null)).toBe(false);
  expect(traps).toBe(0);
});
