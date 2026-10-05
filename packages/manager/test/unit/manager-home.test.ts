import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {managerHomeLanes, type ManagerHomeLaneInput} from '@threadnote/manager/home';

describe('Manager project home', () => {
  it('keeps the three attention lanes in a stable order', () => {
    const lanes = managerHomeLanes({
      health: {findingCount: 0, status: 'clean'},
      reviews: {pendingCount: 2},
      value: {applied: 1, reviewed: 2, useful: 3},
    });
    expect(lanes.map(lane => lane.id)).toEqual(['reviews', 'health', 'value']);
    expect(lanes.map(lane => lane.status)).toEqual(['attention', 'clear', 'clear']);
  });

  it('counts decision memories independently of diagnostic and incomplete coverage counts', () => {
    const health = managerHomeLanes({
      health: {findingCount: 2_013, status: 'unknown', decisionMemories: 3, automaticCount: 4, coverage: 'partial'},
    }).find(item => item.id === 'health');
    expect(health).toMatchObject({count: 3, status: 'attention'});
    expect(health?.detail).toContain('3 memories need your decision');
    expect(health?.detail).toContain('evidence checks incomplete');
    expect(
      managerHomeLanes({
        health: {findingCount: 2_013, status: 'unknown', decisionMemories: 0, coverage: 'partial'},
      }).find(item => item.id === 'health'),
    ).toMatchObject({count: 0, status: 'unavailable'});
  });

  it('is deterministic under equivalent input reconstruction', () => {
    fc.assert(
      fc.property(
        fc.record({
          health: fc.option(
            fc.record({
              findingCount: fc.integer({min: 0, max: 100}),
              status: fc.constantFrom('clean' as const, 'findings' as const, 'unknown' as const),
            }),
            {nil: undefined},
          ),
          reviews: fc.option(fc.record({pendingCount: fc.integer({min: 0, max: 100})}), {nil: undefined}),
          value: fc.option(
            fc.record({
              applied: fc.integer({min: 0, max: 100}),
              reviewed: fc.integer({min: 0, max: 100}),
              useful: fc.integer({min: 0, max: 100}),
            }),
            {nil: undefined},
          ),
        }),
        input => {
          const reconstructed: ManagerHomeLaneInput = JSON.parse(JSON.stringify(input));
          expect(managerHomeLanes(input)).toEqual(managerHomeLanes(reconstructed));
        },
      ),
      {numRuns: 100},
    );
  });
});
