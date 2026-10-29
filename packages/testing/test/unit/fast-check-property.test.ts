import {expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {fcProp} from '../../src/fast-check-property.js';

fcProp(
  it,
  'dispatches tuple arbitraries without changing positions or value types',
  [FC.integer({min: -100, max: 100}), FC.string({maxLength: 20})] as const,
  ([count, label]) => {
    const incremented: number = count + 1;
    const length: number = label.length;
    expect(typeof count).toBe('number');
    expect(typeof label).toBe('string');
    expect(incremented).toBeGreaterThan(count);
    expect(length).toBeGreaterThanOrEqual(0);
  },
  {fastCheck: {numRuns: 50}},
);

fcProp(
  it,
  'dispatches record arbitraries without changing keys or value types',
  {count: FC.integer({min: -100, max: 100}), label: FC.string({maxLength: 20})},
  ({count, label}) => {
    const incremented: number = count + 1;
    const length: number = label.length;
    expect(typeof count).toBe('number');
    expect(typeof label).toBe('string');
    expect(incremented).toBeGreaterThan(count);
    expect(length).toBeGreaterThanOrEqual(0);
  },
  {fastCheck: {numRuns: 50}},
);
