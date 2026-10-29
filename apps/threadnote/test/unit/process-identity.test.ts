import fc from 'fast-check';
import {Effect} from 'effect';
import {it as effectIt} from '@effect/vitest';
import {describe, expect, it} from 'vitest';
import {succeedUndefined} from '@threadnote/platform/optional';
import {
  observeCanonicalProcessInstanceIdentity,
  observeProcessInstanceIdentity,
  processInstanceIdentityMatches,
} from '@threadnote/threadnote/process/process_identity';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const darwinCLocaleStart = fc
  .tuple(
    fc.constantFrom(...WEEKDAYS),
    fc.constantFrom(...MONTHS),
    fc.integer({min: 1, max: 31}),
    fc.integer({min: 0, max: 23}),
    fc.integer({min: 0, max: 59}),
    fc.integer({min: 0, max: 59}),
    fc.integer({min: 2020, max: 2035}),
  )
  .map(([weekday, month, day, hour, minute, second, year]) => {
    const dayField = day < 10 ? ` ${day}` : String(day);
    const time = `${Effect2.pipe(String(hour), EffectString.padStart(2, '0'))}:${Effect2.pipe(String(minute), EffectString.padStart(2, '0'))}:${Effect2.pipe(String(second), EffectString.padStart(2, '0'))}`;
    return `${weekday} ${month} ${dayField} ${time} ${year}`;
  });

describe('process instance identity', () => {
  it('keeps a live process when observation cannot be read', () => {
    expect(processInstanceIdentityMatches('darwin-v2:Sat Aug  8 23:04:27 2026', undefined)).toBe(true);
    expect(processInstanceIdentityMatches(undefined, 'darwin-v2:Sat Aug  8 23:04:27 2026')).toBe(true);
  });

  it('rejects a canonical identity that no longer matches the running process', () => {
    expect(
      processInstanceIdentityMatches('darwin-v2:Sat Aug  8 23:04:27 2026', 'darwin-v2:Sun Aug  9 00:00:00 2026'),
    ).toBe(false);
  });

  it('does not treat two different locale-sensitive Darwin strings as the same process', () => {
    expect(processInstanceIdentityMatches('darwin:Thu Sep 10 16:44:09 2026', 'darwin:Thu 10 Sep 16:44:09 2026')).toBe(
      false,
    );
  });

  it('accepts a pre-canonical Darwin row once the observer has a locale-stable identity', () => {
    fc.assert(
      fc.property(darwinCLocaleStart, start => {
        expect(processInstanceIdentityMatches(`darwin:${start}`, `darwin-v2:${start}`)).toBe(true);
        expect(processInstanceIdentityMatches(`darwin-v2:${start}`, `darwin:${start}`)).toBe(true);
        expect(processInstanceIdentityMatches(`darwin-v2:${start}`, `darwin-v2:${start}`)).toBe(true);
      }),
      {numRuns: 200},
    );
  });

  it('keeps a canonical Darwin row when observation falls back to a locale-sensitive string', () => {
    expect(
      processInstanceIdentityMatches('darwin-v2:Thu Sep 10 16:19:47 2026', 'darwin:Thu 10 Sep 18:19:47 2026'),
    ).toBe(true);
  });
});

describe('observeProcessInstanceIdentity', () => {
  effectIt.effect('prefers canonical process start identity when it is defined', () =>
    Effect.gen(function* () {
      const observed = yield* observeProcessInstanceIdentity(
        {
          canonicalProcessStartIdentity: () => Effect.succeed('darwin-v2:canonical'),
          processStartIdentity: () => Effect.succeed('darwin:fallback'),
        },
        1,
      );
      expect(observed).toBe('darwin-v2:canonical');
    }),
  );

  effectIt.effect('falls back to locale-sensitive identity when canonical observation is missing', () =>
    Effect.gen(function* () {
      const observed = yield* observeProcessInstanceIdentity(
        {
          processStartIdentity: () => Effect.succeed('darwin:fallback'),
        },
        1,
      );
      expect(observed).toBe('darwin:fallback');
    }),
  );

  effectIt.effect('falls back when canonical observation returns undefined', () =>
    Effect.gen(function* () {
      const observed = yield* observeProcessInstanceIdentity(
        {
          canonicalProcessStartIdentity: () => succeedUndefined,
          processStartIdentity: () => Effect.succeed('darwin:fallback'),
        },
        1,
      );
      expect(observed).toBe('darwin:fallback');
    }),
  );
});

describe('observeCanonicalProcessInstanceIdentity', () => {
  effectIt.effect('does not fall back to a locale-sensitive identity for keep decisions', () =>
    Effect.gen(function* () {
      const observed = yield* observeCanonicalProcessInstanceIdentity(
        {
          canonicalProcessStartIdentity: () => succeedUndefined,
        },
        1,
      );
      expect(observed).toBeUndefined();
    }),
  );
});
