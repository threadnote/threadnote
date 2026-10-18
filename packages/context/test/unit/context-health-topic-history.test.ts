import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {createMemoryCodeCitation} from '@threadnote/memory/code/citation';
import {formatMemoryDocument, parseMemoryDocument, type MemoryRecord} from '@threadnote/memory/document';
import {proposeTopicMaintenanceEnrollment} from '@threadnote/memory/topic-maintenance';
import {buildContextHealthReport} from '@threadnote/context/health';
import {contextHealthCitationCoverageV2} from '@threadnote/context/health_maintenance';
import type {ContextBriefCitationValidationReceiptV2} from '@threadnote/context/types';

const now = new Date('2026-10-18T12:00:00.000Z');
const uri = 'threadnote://user/tester/memories/durable/projects/threadnote/topic.md';
const citation = (hash: string, path = 'src/draft.ts') =>
  createMemoryCodeCitation({
    version: 1,
    evidenceRetention: 'capsule-retained',
    extractorSet: 'fixture',
    fileContentHash: {algorithm: 'sha256', value: hash.repeat(64)},
    path,
    repositoryId: '1'.repeat(64),
    repositoryIdentityKind: 'remote',
    sourceCommit: '2'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: `cgsn_${'3'.repeat(40)}`,
    target: {kind: 'file'},
  });
const original = citation('a');
const previous = citation('b');
const current = citation('c');
const policy = citation('d', 'src/policy.ts');
const retained = [original, previous];

function topic(version: 2 | 3 = 2): MemoryRecord {
  const source = parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        kind: 'durable',
        status: 'active',
        project: 'threadnote',
        topic: 'topic-history',
        sourceAgentClient: 'test',
        timestamp: now.toISOString(),
        memoryId: 'tn_topic_history_fixture',
        schemaVersion: 10,
        codeCitations: [original, previous, current, policy],
      },
      'Draft output is limited to 48 KiB.\n\nHistorically the limit was 32 KiB.\n\nPolicy: reviewed approval is required.',
    ),
  )!;
  const enrolled = parseMemoryDocument(
    uri,
    proposeTopicMaintenanceEnrollment(source, {
      paragraphs: [
        {role: 'descriptive', support: 'direct', citationIds: [current.id]},
        {role: 'historical', support: 'direct', citationIds: [original.id]},
        {role: 'normative', support: 'direct', citationIds: [policy.id]},
      ],
    }).content,
  )!;
  const manifest = enrolled.metadata.topicMaintenance;
  if (manifest?.version !== 1) throw new Error('Expected a code V1 enrollment fixture.');
  return parseMemoryDocument(
    uri,
    formatMemoryDocument(
      'MEMORY',
      {
        ...enrolled.metadata,
        topicMaintenance: {
          ...manifest,
          ...(version === 3 ? {version: 3 as const, sourceKind: 'code' as const} : {version: 2 as const}),
          originCitationIds: [original.id, policy.id].sort(),
          acceptedSources: [original, current, policy]
            .map(item => ({citationId: item.id, acceptedCitationId: item.id === original.id ? current.id : item.id}))
            .sort((left, right) => left.citationId.localeCompare(right.citationId)),
        },
      },
      enrolled.body,
    ),
  )!;
}

function receipt(
  id: string,
  status: 'exact' | 'changed' | 'deleted' | 'unknown',
): ContextBriefCitationValidationReceiptV2 {
  return {
    citationId: id,
    candidateCount: 0,
    coverage: status === 'unknown' ? 'incomplete' : 'current-complete',
    kind: 'file',
    observedAt: now.toISOString(),
    reason:
      status === 'changed'
        ? 'source-changed'
        : status === 'deleted'
          ? 'source-deleted'
          : status === 'unknown'
            ? 'repository-unavailable'
            : 'exact',
    status,
    strategy: 'content-hash',
    validatorVersion: 1,
  };
}

function report(record: MemoryRecord, receipts: readonly ContextBriefCitationValidationReceiptV2[]) {
  return buildContextHealthReport({
    now,
    project: 'threadnote',
    records: [record],
    citationValidations: [{uri, receipts}],
  });
}
const citationFindings = (value: ReturnType<typeof report>) =>
  value.findings.filter(finding => finding.category.startsWith('citation-'));

describe.each([2, 3] as const)('accepted code V%s topic citation health', version => {
  it('does not reopen accepted prose for drift of original or previously accepted retained pins', () => {
    const record = topic(version);
    const receipts = [
      receipt(original.id, 'changed'),
      receipt(previous.id, 'deleted'),
      receipt(current.id, 'exact'),
      receipt(policy.id, 'exact'),
    ];
    const before = JSON.stringify({record, receipts});
    const result = report(record, receipts);
    expect(citationFindings(result)).toEqual([]);
    expect(result.maintenance?.citationCoverage).toEqual(
      contextHealthCitationCoverageV2({records: [record], validations: [{uri, receipts}]}),
    );
    expect(JSON.stringify({record, receipts})).toBe(before);
  });

  it('keeps current accepted source drift actionable regardless of retained-pin status and receipt ordering', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('changed' as const, 'deleted' as const),
        fc.tuple(fc.constantFrom('exact' as const, 'changed' as const, 'deleted' as const), fc.boolean()),
        fc.boolean(),
        (activeStatus, [retainedStatus, reverse], omitActive) => {
          const record = topic(version);
          const receipts = [
            ...retained.map(item => receipt(item.id, retainedStatus)),
            ...(!omitActive ? [receipt(current.id, activeStatus)] : []),
            receipt(policy.id, 'exact'),
          ];
          const result = report(record, reverse ? [...receipts].reverse() : receipts);
          const targets = citationFindings(result).map(finding => finding.repair.targetUri);
          expect(targets).toEqual(omitActive ? [] : [`${uri}#${current.id}`]);
          if (omitActive) expect(result.maintenance?.citationCoverage.state).not.toBe('complete');
        },
      ),
      {numRuns: 24},
    );
  });

  it('preserves unknown historical evidence as coverage rather than making it current', () => {
    const result = report(topic(version), [receipt(original.id, 'unknown'), receipt(current.id, 'exact')]);
    expect(citationFindings(result)).toEqual([
      expect.objectContaining({category: 'citation-unknown', classification: 'coverage'}),
    ]);
    expect(result.maintenance?.citationCoverage.state).not.toBe('complete');
  });

  it('still reports drift of identity-mapped policy support alongside the accepted descriptive pin', () => {
    const result = report(topic(version), [
      receipt(original.id, 'changed'),
      receipt(previous.id, 'deleted'),
      receipt(current.id, 'changed'),
      receipt(policy.id, 'deleted'),
    ]);
    expect(
      citationFindings(result)
        .map(finding => finding.repair.targetUri)
        .sort(),
    ).toEqual([`${uri}#${current.id}`, `${uri}#${policy.id}`].sort());
    expect(citationFindings(result).every(finding => finding.classification === 'actionable')).toBe(true);
  });

  it('does not suppress drift for V1, ordinary records, invalid manifests or foreign receipt identities', () => {
    const record = topic(version);
    const {topicMaintenance: manifest, ...plainMetadata} = record.metadata;
    if (!manifest || manifest.version === 1 || (manifest.version === 3 && manifest.sourceKind !== 'code'))
      throw new Error('Expected accepted code topic fixture');
    const {originCitationIds: _origins, acceptedSources: _accepted, ...common} = manifest;
    const legacy = 'sourceKind' in common ? (({sourceKind: _kind, ...rest}) => rest)(common) : common;
    const records: MemoryRecord[] = [
      {...record, metadata: plainMetadata},
      {...record, metadata: {...record.metadata, topicMaintenance: {...legacy, version: 1}}},
      {...record, body: record.body + '\n\nAn unreviewed paragraph.'},
    ];
    for (const item of records) {
      expect(citationFindings(report(item, [receipt(original.id, 'changed')]))).toHaveLength(1);
    }
    const foreign = citation('e', 'src/unrelated.ts');
    expect(citationFindings(report(record, [receipt(foreign.id, 'changed')]))).toHaveLength(1);
  });
});
