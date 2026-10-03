import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {groupMaintenanceCauses, maintenanceStatusLabel} from '@threadnote/manager/attention/maintenance';
import type {ManagerContextMaintenanceCaseV2} from '@threadnote/manager/attention/contracts';

const caseAt = (index: number): ManagerContextMaintenanceCaseV2 => ({
  caseId: `case-${index}`,
  project: 'threadnote',
  memoryId: `memory-${index}`,
  family: 'citation',
  slot: `${index}`,
  disposition: 'waiting-evidence',
  evidenceRevision: 'a'.repeat(64),
  reason: 'repository-unavailable',
  repositoryId: 'repo-one',
  firstSeen: '2026-10-03',
  lastSeen: '2026-10-03',
  lastChecked: '2026-10-03',
  attemptCount: 1,
  events: [],
});

describe('maintenance presentation', () => {
  it('groups 200 blocked anchors for one repository into one recovery row', () => {
    const groups = groupMaintenanceCauses(Array.from({length: 200}, (_, index) => caseAt(index)));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({count: 200, repositoryId: 'repo-one', reason: 'repository-unavailable'});
  });
  it('is permutation invariant and repeated receipts cannot inflate recovery counts', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 200}), count => {
        const cases = Array.from({length: count}, (_, index) => caseAt(index));
        expect(groupMaintenanceCauses([...cases].reverse().concat(cases))).toEqual(groupMaintenanceCauses(cases));
      }),
      {numRuns: 40},
    );
  });
  it('never calls incomplete zero-decision evidence verified', () => {
    expect(maintenanceStatusLabel({decisions: 0, coverage: 'partial', paused: false, state: 'idle'})).toBe(
      'No decisions needed; evidence checks are incomplete',
    );
    expect(maintenanceStatusLabel({decisions: 3, coverage: 'partial', paused: false, state: 'waiting-evidence'})).toBe(
      '3 memories need your decision',
    );
  });
});
