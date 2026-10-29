import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {buildHomeAttentionModel} from '../../src/home_scene.js';

describe('Home attention flow', () => {
  it('maps live inventory, attention, and outcome values to useful destinations', () => {
    expect(
      buildHomeAttentionModel({
        coverage: 'partial',
        findings: 5,
        memories: 12,
        outcomes: 8,
        pending: 3,
        scanned: 28,
      }),
    ).toEqual([
      expect.objectContaining({action: 'memory', id: 'context', status: 'available', value: '12'}),
      expect.objectContaining({action: 'reviews', id: 'reviews', status: 'attention', value: '3'}),
      expect.objectContaining({action: 'context-health', id: 'health', status: 'attention', value: '5'}),
      expect.objectContaining({action: 'context', id: 'outcomes', status: 'available', value: '8'}),
    ]);
    expect(buildHomeAttentionModel({coverage: 'partial', memories: 12, scanned: 28})[0]?.detail).toBe(
      '28 scanned · partial coverage',
    );
  });

  it('distinguishes clear, unavailable, and invalid count states without inventing data', () => {
    const nodes = buildHomeAttentionModel({findings: 0, memories: 1_000_000, pending: -4});
    expect(EffectArray.map(nodes, node => node.value)).toEqual(['1,000,000', '0', '0', 'Unavailable']);
    expect(EffectArray.map(nodes, node => node.status)).toEqual(['available', 'clear', 'clear', 'unavailable']);
  });

  it('normalizes every live count to a non-negative integer', () => {
    fc.assert(
      fc.property(fc.double({max: 100_000, min: -100_000, noNaN: true, noDefaultInfinity: true}), (count: number) => {
        const nodes = buildHomeAttentionModel({findings: count, memories: count, outcomes: count, pending: count});
        const expected = Math.max(0, Math.floor(count)).toLocaleString();
        expect(EffectArray.map(nodes, node => node.value)).toEqual([expected, expected, expected, expected]);
      }),
      {numRuns: 100},
    );
  });
});
