import {Array as EffectArray} from 'effect';
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
    version: 2,
    state: 'complete',
    eligibleRecords: 0,
    analyzedRecords: 0,
    unknownRecords: 0,
    claimsAnalyzed: 0,
    supportedClaims: 0,
    unsupportedClaims: 0,
    coverage: 'bounded-English-extraction',
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
        const cases = EffectArray.map(memories, (subjects, index) => ({
          ...makeCase(subjects[0], index),
          subjectContentHashes: EffectArray.map(subjects, memory => ({
            uri: `threadnote://user/tester/memories/memory-${memory}.md`,
            hash: 'hash',
          })),
        }));
        const before = JSON.stringify(cases);
        const groups = healthDecisionGroups(report, cases);
        const reversed = healthDecisionGroups(
          report,
          EffectArray.flatMap([...cases].reverse(), item => [item, item]),
        );
        expect(EffectArray.map(groups, group => group.uri)).toEqual(
          [
            ...new Set(
              EffectArray.map(memories.flat(), memory => `threadnote://user/tester/memories/memory-${memory}.md`),
            ),
          ].sort(),
        );
        expect(
          EffectArray.flatMap(groups, group =>
            EffectArray.map(group.cases, item => `${item.caseId}:${group.uri}`),
          ).sort(),
        ).toEqual(
          EffectArray.flatMap(cases, item =>
            EffectArray.map(item.subjectContentHashes, subject => `${item.caseId}:${subject.uri}`),
          ).sort(),
        );
        expect(reversed).toEqual(groups);
        expect(JSON.stringify(cases)).toBe(before);
      },
    ),
    {numRuns: 60},
  );
});
