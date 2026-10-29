// @vitest-environment happy-dom
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, it, vi} from 'vitest';
import fc from 'fast-check';
import {formatRelativeAge, useRelativeTimeNow} from '../../src/relative_time.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const now = Date.parse('2026-10-09T12:00:00Z');

it('formats snapshot ages across second, minute, hour and day boundaries', () => {
  for (const [seconds, expected] of [
    [0, '0 sec ago'],
    [59, '59 sec ago'],
    [60, '1 min ago'],
    [3599, '59 min ago'],
    [3600, '1 hour ago'],
    [86400, '1 day ago'],
    [172800, '2 days ago'],
  ] as const) {
    expect(formatRelativeAge(new Date(now - seconds * 1000).toISOString(), now)).toBe(expected);
  }
  expect(formatRelativeAge(new Date(now + 1000).toISOString(), now)).toBe('0 sec ago');
  expect(formatRelativeAge(undefined, now)).toBeUndefined();
  expect(formatRelativeAge('invalid', now)).toBeUndefined();
});

it('always reports a nonnegative age in a unit containing the elapsed time', () => {
  fc.assert(
    fc.property(fc.integer({min: 0, max: 365 * 86400}), seconds => {
      const label = formatRelativeAge(new Date(now - seconds * 1000).toISOString(), now)!;
      const [, count, unit] = /^(\d+) (sec|min|hours?|days?) ago$/u.exec(label)!;
      const scale =
        unit === 'sec' ? 1 : unit === 'min' ? 60 : Effect.pipe(unit, EffectString.startsWith('hour')) ? 3600 : 86400;
      expect(Number(count) * scale).toBeLessThanOrEqual(seconds);
      expect((Number(count) + 1) * scale).toBeGreaterThan(seconds);
    }),
    {numRuns: 80},
  );
});

it('updates an age without a page refresh and releases the clock on unmount', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {configurable: true, value: true});
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const container = document.createElement('div');
  const root = createRoot(container);
  function Age() {
    return createElement(
      'time',
      undefined,
      formatRelativeAge(new Date(now - 59_000).toISOString(), useRelativeTimeNow()),
    );
  }
  try {
    await act(async () => root.render(createElement(Age)));
    expect(container.textContent).toBe('59 sec ago');
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(container.textContent).toBe('1 min ago');
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
