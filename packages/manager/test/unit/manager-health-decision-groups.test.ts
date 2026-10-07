import {expect, it} from 'vitest';
import fc from 'fast-check';
import {healthDecisionGroups} from '../../src/attention/maintenance.js';
import type {ManagerContextHealthResponseV1, ManagerContextMaintenanceCaseV2} from '../../src/attention/contracts.js';

const report: ManagerContextHealthResponseV1 = {
  version: 1,
  project: 'threadnote',
  findings: [],
  recordPreviews: [],
  limit: 100,
  omittedFindings: 0,
  recordsScanned: 0,
  status: 'unknown',
  repositoryEvidence: {state: 'unavailable', reason: 'repository-unavailable'},
  semanticCompleteness: {
    version: 1,
    state: 'complete',
    eligibleRecords: 0,
    analyzedRecords: 0,
    unknownRecords: 0,
    claimsAnalyzed: 0,
    contradictionCount: 0,
    pairsCompared: 0,
    omittedContradictions: 0,
    unknownReasons: [],
  },
};
const makeCase = (memory: number, index: number): ManagerContextMaintenanceCaseV2 => ({
  caseId: `case-${index}`,
  project: 'threadnote',
  memoryId: `memory-${memory}`,
  family: 'citation',
  slot: 'anchor',
  disposition: 'needs-decision',
  reason: 'source-changed',
  evidenceRevision: 'revision',
  subjectContentHashes: [{uri: `threadnote://user/tester/memories/memory-${memory}.md`, hash: 'hash'}],
  firstSeen: 'now',
  lastSeen: 'now',
  lastChecked: 'now',
  attemptCount: 1,
  events: [],
});

it('groups represented and retained checks by memory without hiding the remaining checks', () => {
  const first = makeCase(1, 1);
  const second = makeCase(1, 2);
  const findings: ManagerContextHealthResponseV1['findings'] = [
    {
      id: 'finding-one',
      caseId: first.caseId,
      classification: 'actionable',
      category: 'citation-changed',
      confidence: 'high',
      severity: 'high',
      summary: 'Source changed',
      repairability: 'manual-review',
      uris: [first.subjectContentHashes![0].uri],
      repair: {kind: 'review-memory', summary: 'Review claim'},
    },
  ];
  const groups = healthDecisionGroups({...report, findings}, [first, second, second]);
  expect(groups).toHaveLength(1);
  expect(groups[0].findings).toEqual(findings);
  expect(groups[0].cases).toEqual([second]);
  expect(groups[0].uri).toBe(first.subjectContentHashes![0].uri);
});

it('keeps all subjects of a repository review accessible when one subject already has a finding', () => {
  const first = makeCase(1, 1);
  const other = makeCase(2, 2);
  const sharedCase = {
    ...first,
    family: 'repository-recovery',
    subjectContentHashes: [...first.subjectContentHashes!, ...other.subjectContentHashes!],
  };
  const finding: ManagerContextHealthResponseV1['findings'][number] = {
    id: 'finding-one',
    caseId: first.caseId,
    classification: 'actionable',
    category: 'citation-changed',
    confidence: 'high',
    severity: 'high',
    summary: 'Review source',
    repairability: 'manual-review',
    uris: [first.subjectContentHashes![0].uri],
    repair: {kind: 'review-memory', summary: 'Review claim'},
  };
  const groups = healthDecisionGroups({...report, findings: [finding]}, [sharedCase, sharedCase]);
  expect(groups).toHaveLength(2);
  expect(groups[0].findings).toEqual([finding]);
  expect(groups[0].cases).toEqual([]);
  expect(groups[1].uri).toBe(other.subjectContentHashes![0].uri);
  expect(groups[1].cases).toEqual([sharedCase]);
});

it('preserves every case for every subject and keeps grouping stable under page order and duplicate delivery', () => {
  fc.assert(
    fc.property(
      fc.array(fc.uniqueArray(fc.integer({min: 0, max: 8}), {minLength: 1, maxLength: 4}), {maxLength: 30}),
      memories => {
        const cases = memories.map((subjects, index) => ({
          ...makeCase(subjects[0], index),
          subjectContentHashes: subjects.map(memory => ({
            uri: `threadnote://user/tester/memories/memory-${memory}.md`,
            hash: 'hash',
          })),
        }));
        const before = JSON.stringify(cases);
        const groups = healthDecisionGroups(report, cases);
        const reversed = healthDecisionGroups(
          report,
          [...cases].reverse().flatMap(item => [item, item]),
        );
        expect(groups.map(group => group.uri)).toEqual(
          [...new Set(memories.flat().map(memory => `threadnote://user/tester/memories/memory-${memory}.md`))].sort(),
        );
        expect(groups.flatMap(group => group.cases.map(item => `${item.caseId}:${group.uri}`)).sort()).toEqual(
          cases.flatMap(item => item.subjectContentHashes.map(subject => `${item.caseId}:${subject.uri}`)).sort(),
        );
        expect(reversed).toEqual(groups);
        expect(JSON.stringify(cases)).toBe(before);
      },
    ),
    {numRuns: 60},
  );
});
