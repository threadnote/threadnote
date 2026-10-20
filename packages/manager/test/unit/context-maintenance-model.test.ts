import fc from 'fast-check';
import {buildContextHealthReport} from '@threadnote/context/health';
import {describe, expect, it} from 'vitest';
import {
  groupMaintenanceCauses,
  maintenanceStatusLabel,
  mergeMaintenanceStatusPage,
  reconcileAppliedMaintenanceCases,
  reconcileAppliedHealthReport,
} from '@threadnote/manager/attention/maintenance';
import type {
  ManagerContextMaintenanceCaseV2,
  ManagerContextMaintenanceReceiptV2,
  ManagerContextMaintenanceStatusV2,
  ManagerContextHealthResponseV1,
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
  it('reconciles only receipt-proven report slots and preserves unrelated findings, hashes and observations', () => {
    fc.assert(
      fc.property(
        fc.integer({min: 0, max: 12}),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (otherCount, sameProject, sameHash, sameObservation, hasProof) => {
          const uri = 'threadnote://memory/topic';
          const finding = (index: number): ManagerContextHealthResponseV1['findings'][number] => ({
            id: `finding-${index}`,
            category: index % 3 === 1 ? 'semantic-contradiction' : 'citation-changed',
            confidence: 'high',
            severity: 'high',
            classification: 'actionable',
            repairability: 'reviewable',
            summary: 'Review source',
            uris: [index % 3 === 2 ? 'threadnote://memory/other' : uri],
            repair: {
              kind: 'review-memory',
              subjectUri: index % 3 === 2 ? 'threadnote://memory/other' : uri,
              targetUri: `${uri}#citation-${index}`,
              summary: 'Review',
            },
          });
          const findings = Array.from({length: otherCount + 1}, (_, index) => finding(index));
          const base = buildContextHealthReport({project: 'threadnote', records: [], now: new Date('2026-10-01')});
          const original: ManagerContextHealthResponseV1 = {
            ...base,
            findings,
            recordPreviews: [
              {
                uri,
                title: 'Topic',
                kind: 'durable',
                excerpt: 'Claim',
                contentHash: sameHash ? 'old-hash' : 'new-hash',
                code: findings.map((item, index) => ({
                  citationId: `citation-${index}`,
                  path: 'source.ts',
                  findingIds: [item.id],
                })),
              },
            ],
            repositoryEvidence: {state: 'available'},
            maintenance: {
              ...base.maintenance!,
              actionableFindings: findings.length,
              affectedMemories: new Set(findings.flatMap(item => item.uris)).size,
            },
          };
          const before = JSON.stringify(original);
          const receipts = [
            {
              project: sameProject ? 'threadnote' : 'other',
              caseId: 'case-2',
              evidenceRevision: 'old',
              targetUri: uri,
              targetHash: 'old-hash',
              ...(hasProof ? {resolvedCitationIds: ['citation-0']} : {}),
            },
          ];
          const status: ManagerContextMaintenanceStatusV2 = {
            version: 2,
            paused: false,
            state: 'needs-decision',
            generation: 'one',
            projects: [],
            cases: [{...caseAt(2), evidenceRevision: sameObservation ? 'old' : 'new', disposition: 'needs-decision'}],
            receipts: [],
          };
          const next = reconcileAppliedHealthReport(original, receipts, status);
          const resolves = sameProject && sameHash && sameObservation && hasProof;
          expect(next.findings).toEqual(resolves ? findings.slice(1) : findings);
          expect(next.maintenance?.actionableFindings).toBe(findings.length - Number(resolves));
          expect(next.maintenance?.affectedMemories).toBe(
            new Set((resolves ? findings.slice(1) : findings).flatMap(item => item.uris)).size,
          );
          expect(reconcileAppliedHealthReport(next, receipts, status)).toEqual(next);
          expect(reconcileAppliedHealthReport(original, [{...receipts[0], caseId: undefined}], status)).toBe(original);
          const missingHash = {
            ...original,
            recordPreviews: original.recordPreviews.map(preview => ({...preview, contentHash: undefined})),
          };
          expect(reconcileAppliedHealthReport(missingHash, receipts, status)).toBe(missingHash);
          expect(JSON.stringify(original)).toBe(before);
        },
      ),
      {numRuns: 60},
    );
  });
  it('reconciles exact applied observations idempotently without removing unrelated or newer revisions', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({id: fc.integer({min: 0, max: 12}), revision: fc.integer({min: 0, max: 3})}), {
          maxLength: 40,
        }),
        values => {
          const cases = values.map(({id, revision}) => ({
            ...caseAt(id),
            disposition: 'needs-decision' as const,
            evidenceRevision: `revision-${revision}`,
          }));
          const original: ManagerContextMaintenanceStatusV2 = {
            version: 2,
            generation: 'one',
            state: 'needs-decision',
            paused: false,
            projects: [],
            cases,
            receipts: [],
            counts: {'needs-decision': cases.length, decisionMemories: new Set(cases.map(item => item.memoryId)).size},
          };
          const before = JSON.stringify(original);
          const applied = [{project: 'threadnote', caseId: 'case-2', evidenceRevision: 'revision-1'}];
          const next = reconcileAppliedMaintenanceCases(original, applied);
          expect(next.cases).toEqual(
            cases.filter(item => item.caseId !== 'case-2' || item.evidenceRevision !== 'revision-1'),
          );
          expect(next.counts?.['needs-decision']).toBe(next.cases.length);
          expect(next.counts?.decisionMemories).toBe(new Set(next.cases.map(item => item.memoryId)).size);
          expect(reconcileAppliedMaintenanceCases(next, applied)).toEqual(next);
          expect(JSON.stringify(original)).toBe(before);
          expect(reconcileAppliedMaintenanceCases(original, [{...applied[0], project: 'another'}])).toBe(original);
        },
      ),
      {numRuns: 50},
    );
  });
  it('groups 200 blocked anchors for one repository into one recovery row', () => {
    const groups = groupMaintenanceCauses(Array.from({length: 200}, (_, index) => caseAt(index)));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({count: 200, repositoryId: 'repo-one', reason: 'repository-unavailable'});
  });
  it('keeps aggregate memory attention conservative while other case details are unloaded', () => {
    const item = {...caseAt(2), disposition: 'needs-decision' as const};
    const original: ManagerContextMaintenanceStatusV2 = {
      version: 2,
      generation: 'one',
      state: 'needs-decision',
      paused: false,
      projects: [],
      cases: [item],
      receipts: [],
      omittedCases: 1,
      counts: {'needs-decision': 2, decisionMemories: 1},
    };
    const next = reconcileAppliedMaintenanceCases(original, [
      {project: item.project, caseId: item.caseId, evidenceRevision: item.evidenceRevision},
    ]);
    expect(next.cases).toEqual([]);
    expect(next.counts).toEqual({'needs-decision': 1, decisionMemories: 1});
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
