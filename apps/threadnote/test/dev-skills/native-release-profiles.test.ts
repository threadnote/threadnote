import {expect, it} from 'vitest';
import fc from 'fast-check';
import {Array} from 'effect';
import {selectNativeReleaseProfiles} from './native-release-profiles.js';

const profiles = ['desktop', 'codex-cloud-personal', 'cursor-cloud-personal'];

it('preserves the complete default qualification and refuses unavailable profiles', () => {
  expect(selectNativeReleaseProfiles(profiles)).toEqual(profiles);
  expect(selectNativeReleaseProfiles(['desktop'], 'all')).toEqual(['desktop']);
  expect(() => selectNativeReleaseProfiles(['desktop'], 'codex-cloud-personal')).toThrow('Unavailable');
  expect(() => selectNativeReleaseProfiles(profiles, 'unknown')).toThrow('Unavailable');
});

it('partitions every supported profile exactly once without mutating the catalog inventory', () => {
  fc.assert(
    fc.property(fc.shuffledSubarray(profiles, {minLength: 1}), available => {
      const original = [...available];
      expect(Array.flatMap(available, profile => selectNativeReleaseProfiles(available, profile))).toEqual(available);
      expect(available).toEqual(original);
    }),
    {numRuns: 32},
  );
});
