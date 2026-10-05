import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  groupMaintenanceCauses,
  maintenanceStatusLabel,
  mergeMaintenanceStatusPage,
} from '@threadnote/manager/attention/maintenance';
import type {
  ManagerContextMaintenanceCaseV2,
  ManagerContextMaintenanceReceiptV2,
  ManagerContextMaintenanceStatusV2,
} from '@threadnote/manager/attention/contracts';

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
  it('merges retained pages idempotently and never accepts a different generation', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 100}), count => {
        const cases = Array.from({length: count}, (_, index) => caseAt(index));
        const current = {
          version: 2 as const,
          state: 'idle' as const,
          generation: 'corpus',
          paused: false,
          projects: [],
          cases: cases.slice(0, 10),
          receipts: [],
          omittedCases: Math.max(0, count - 10),
          page: {generation: 'page', receiptNextCursor: 'receipts'},
        };
        const page = {
          ...current,
          cases: cases.slice(10),
          omittedCases: Math.min(count, 10),
          page: {generation: 'page'},
        };
        const merged = mergeMaintenanceStatusPage(current, page, 'cases');
        expect(merged.cases).toEqual(cases);
        expect(merged.omittedCases).toBe(0);
        expect(mergeMaintenanceStatusPage(merged, page, 'cases')).toEqual(merged);
        expect(merged.page?.receiptNextCursor).toBe('receipts');
        expect(() => mergeMaintenanceStatusPage(current, {...page, page: {generation: 'changed'}}, 'cases')).toThrow(
          'Refresh',
        );
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
  it('clears omissions after loading every retained case and receipt across multiple pages', () => {
    const cases = Array.from({length: 73}, (_, index) => caseAt(index));
    const receipts: ManagerContextMaintenanceReceiptV2[] = Array.from({length: 23}, (_, index) => ({
      receiptId: `receipt-${index}`,
      project: 'threadnote',
      subjectUri: `threadnote://user/tester/memories/handoffs/active/threadnote/record-${index}.md`,
      postHash: 'a'.repeat(64),
      timestamp: '2026-10-03',
      state: 'applied',
    }));
    const pageAt = (caseOffset: number, receiptOffset: number): ManagerContextMaintenanceStatusV2 => {
      const selectedCases = cases.slice(caseOffset, caseOffset + 30);
      const selectedReceipts = receipts.slice(receiptOffset, receiptOffset + 10);
      return {
        version: 2,
        state: 'idle',
        generation: 'corpus',
        paused: false,
        projects: [],
        cases: selectedCases,
        receipts: selectedReceipts,
        omittedCases: cases.length - selectedCases.length,
        omittedReceipts: receipts.length - selectedReceipts.length,
        page: {generation: 'page'},
      };
    };
    let loaded = pageAt(0, 0);
    loaded = mergeMaintenanceStatusPage(loaded, pageAt(30, 0), 'cases');
    expect(loaded.omittedCases).toBe(13);
    loaded = mergeMaintenanceStatusPage(loaded, pageAt(60, 0), 'cases');
    expect(loaded.cases).toEqual(cases);
    expect(loaded.omittedCases).toBe(0);
    loaded = mergeMaintenanceStatusPage(loaded, pageAt(0, 10), 'receipts');
    expect(loaded.omittedReceipts).toBe(3);
    loaded = mergeMaintenanceStatusPage(loaded, pageAt(0, 20), 'receipts');
    expect(loaded.receipts).toEqual(receipts);
    expect(loaded.omittedReceipts).toBe(0);
    expect(mergeMaintenanceStatusPage(loaded, pageAt(0, 20), 'receipts')).toEqual(loaded);
  });
});
