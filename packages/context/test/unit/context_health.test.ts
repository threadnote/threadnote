import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import type {MemoryMetadata, MemoryRecord} from '@threadnote/memory/document';
import {
  contextHealthCaseIdV2,
  contextHealthFindingCaseIdentityV2,
  resolveContextHealthRelationTargetV2,
} from '@threadnote/context/health_maintenance';
import type {ContextBriefCitationValidationReceiptV2} from '@threadnote/context/types';
import {buildContextHealthReport} from '@threadnote/context/health';

const now = new Date('2026-09-17T12:00:00.000Z');

function record(uri: string, body: string, metadata: Partial<MemoryMetadata> = {}): MemoryRecord {
  const complete = {
    kind: 'durable' as const,
    project: 'threadnote',
    sourceAgentClient: 'codex',
    status: 'active' as const,
    timestamp: '2026-09-01T00:00:00.000Z',
    topic: 'context-health',
    ...metadata,
  };
  return {
    body,
    content: [
      'MEMORY',
      `kind: ${complete.kind}`,
      `status: ${complete.status}`,
      `project: ${complete.project}`,
      `topic: ${complete.topic}`,
      `source_agent_client: ${complete.sourceAgentClient}`,
      `timestamp: ${complete.timestamp}`,
      '',
      body,
    ].join('\n'),
    headerTitle: complete.kind === 'handoff' ? 'HANDOFF' : 'MEMORY',
    metadata: complete,
    uri,
  };
}

describe('buildContextHealthReport', () => {
  it('reports the 2,001-citation admission tail as coverage rather than content damage', () => {
    const records = Array.from({length: 2_001}, (_, index) =>
      record(`threadnote://memory/tn_${index}`, `unique claim ${index}`, {kind: 'handoff'}),
    );
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records,
      citationValidations: records.map((item, index) => ({
        uri: item.uri,
        receipts: [
          {
            ...receipt('unknown', 'repository-unavailable'),
            citationId: `citation-${index}`,
            reason: index < 96 ? 'exact' : 'citation-limit',
            status: index < 96 ? 'exact' : 'unknown',
            coverage: index < 96 ? 'current-complete' : 'incomplete',
          },
        ],
      })),
    });
    expect(report.findings).toEqual([]);
    expect(report.status).toBe('unknown');
    expect(report.maintenance).toMatchObject({
      actionableFindings: 0,
      citationCoverage: {
        eligible: 2_001,
        checked: 96,
        deferred: 1_905,
        state: 'partial',
        reasons: [{reason: 'citation-limit', count: 1_905}],
      },
    });
  });

  it('keeps admission invariance under valid corpus growth', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 150}), count => {
        const records = Array.from({length: count}, (_, index) =>
          record(`threadnote://memory/tn_${index}`, `unique ${index}`, {kind: 'handoff'}),
        );
        const report = buildContextHealthReport({
          now,
          project: 'threadnote',
          records,
          citationValidations: records.map((item, index) => ({
            uri: item.uri,
            receipts: [
              {
                ...receipt('unknown', 'repository-unavailable'),
                citationId: `citation-${index}`,
                reason: index < 96 ? 'exact' : 'citation-limit',
                status: index < 96 ? 'exact' : 'unknown',
                coverage: index < 96 ? 'current-complete' : 'incomplete',
              },
            ],
          })),
        });
        expect(report.maintenance?.actionableFindings).toBe(0);
        expect(report.maintenance?.citationCoverage.checked).toBe(Math.min(count, 96));
        expect(report.maintenance?.citationCoverage.deferred).toBe(Math.max(0, count - 96));
      }),
      {numRuns: 40},
    );
  });

  it('keeps stable cases across transient reasons, citation replacement and memory moves', () => {
    const source = record('threadnote://memory/old-path', 'source', {
      memoryId: 'tn_stable',
      codeCitations: [citation('old-citation')],
    });
    const build = (item: MemoryRecord, reason: ContextBriefCitationValidationReceiptV2['reason'], citationId: string) =>
      buildContextHealthReport({
        now,
        project: 'threadnote',
        records: [item],
        citationValidations: [
          {uri: item.uri, receipts: [{...receipt('unknown', 'repository-unavailable'), reason, citationId}]},
        ],
      }).findings[0];
    const first = build(source, 'repository-unavailable', 'old-citation');
    expect(build(source, 'repository-ambiguous', 'old-citation')?.caseId).toBe(first?.caseId);
    const moved = {
      ...source,
      uri: 'threadnote://memory/new-path',
      metadata: {...source.metadata, codeCitations: [citation('new-citation')]},
    };
    expect(build(moved, 'repository-unavailable', 'new-citation')?.caseId).toBe(first?.caseId);
    expect(first?.classification).toBe('coverage');
  });

  it('shares the full canonical anchor ordinal with persisted maintenance cases', () => {
    const source = record('threadnote://memory/source', 'source', {
      memoryId: 'tn_source',
      codeCitations: [citation('first'), citation('second'), citation('third')],
    });
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [source],
      citationValidations: [
        {uri: source.uri, receipts: [{...receipt('changed', 'source-changed'), citationId: 'second'}]},
      ],
    });
    const finding = report.findings[0];
    if (finding === undefined) throw new Error('Expected changed citation finding');
    const identity = contextHealthFindingCaseIdentityV2({project: 'threadnote', finding, records: [source]});
    expect(identity).toEqual({project: 'threadnote', memoryId: 'tn_source', family: 'citation', slot: 'anchor:1'});
    expect(contextHealthCaseIdV2(identity)).toBe(finding.caseId);
  });

  it('separates completed checks, verified current support, historical provenance and deferred work', () => {
    const source = record('threadnote://memory/coverage', 'source', {kind: 'handoff'});
    const receipts: ContextBriefCitationValidationReceiptV2[] = [
      {
        ...receipt('changed', 'source-changed'),
        citationId: 'exact',
        status: 'exact',
        reason: 'exact',
        provenance: 'current-verified',
      },
      {...receipt('changed', 'source-changed'), citationId: 'changed', provenance: 'unverified'},
      {
        ...receipt('deleted', 'source-deleted'),
        citationId: 'deleted',
        coverage: 'incomplete',
        provenance: 'unverified',
      },
      {...receipt('unknown', 'repository-unavailable'), citationId: 'historical', provenance: 'historical-verified'},
      {
        ...receipt('unknown', 'repository-unavailable'),
        citationId: 'queued',
        reason: 'citation-limit',
        provenance: 'unverified',
      },
    ];
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [source],
      citationValidations: [{uri: source.uri, receipts}],
    });
    expect(report.maintenance?.citationCoverage).toMatchObject({
      eligible: 5,
      checked: 3,
      currentVerified: 1,
      historicalVerified: 1,
      deferred: 2,
      unverified: 3,
      state: 'partial',
    });
    expect(report.findings.map(item => item.category)).toEqual(['citation-changed', 'citation-missing']);
    expect(report.status).toBe('unknown');
  });

  it('completes valid current checks that find changed or deleted support without verifying the claims', () => {
    const source = record('threadnote://memory/current-defects', 'source', {kind: 'handoff'});
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [source],
      citationValidations: [
        {
          uri: source.uri,
          receipts: [
            {...receipt('changed', 'source-changed'), provenance: 'unverified'},
            {...receipt('deleted', 'source-deleted'), provenance: 'unverified'},
          ],
        },
      ],
    });
    expect(report.maintenance?.citationCoverage).toMatchObject({
      checked: 2,
      deferred: 0,
      currentVerified: 0,
      unverified: 2,
      state: 'complete',
    });
    expect(report.status).toBe('findings');
  });

  it('keeps incomplete exact receipts checked but abstains from verified current coverage', () => {
    const source = record('threadnote://memory/partial-exact', 'source', {kind: 'handoff'});
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [source],
      citationValidations: [
        {
          uri: source.uri,
          receipts: [
            {
              ...receipt('unknown', 'repository-unavailable'),
              status: 'exact',
              reason: 'exact',
              provenance: 'current-verified',
            },
          ],
        },
      ],
    });
    expect(report.maintenance?.citationCoverage).toMatchObject({
      checked: 1,
      deferred: 0,
      currentVerified: 0,
      state: 'partial',
    });
    expect(report.status).toBe('unknown');
  });

  it('preserves explicit fail-closed coverage findings for Context Check callers', () => {
    const source = record('threadnote://memory/cold-graph', 'source', {kind: 'handoff'});
    const input = {
      now,
      project: 'threadnote',
      records: [source],
      citationValidations: [
        {
          uri: source.uri,
          receipts: [{...receipt('unknown', 'repository-unavailable'), reason: 'graph-incomplete' as const}],
        },
      ],
    };
    expect(buildContextHealthReport(input).findings).toEqual([]);
    const strict = buildContextHealthReport({...input, includeCitationCoverageFindings: true});
    expect(strict.findings).toMatchObject([{category: 'citation-unknown', classification: 'coverage'}]);
    expect(strict.status).toBe('unknown');
  });

  it('uses one stable relation target identity for aliases, direct URIs and archived redirects', () => {
    const target = record('threadnote://user/me/archive/target.md', 'target', {
      memoryId: 'tn_target',
      status: 'archived',
      archivedFrom: 'threadnote://user/me/memories/target.md',
    });
    const selectors = [target.uri, target.metadata.archivedFrom!, 'threadnote://memory/tn_target'];
    const source = record('threadnote://user/me/memories/source.md', 'source', {
      memoryId: 'tn_source',
      relations: selectors.map(uri => ({type: 'references' as const, uri})),
    });
    const corpus = [source, target];
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: corpus,
      relationEvidence: selectors.map(targetUri => ({sourceUri: source.uri, targetUri, status: 'inactive' as const})),
    });
    expect(new Set(report.findings.map(finding => finding.caseId)).size).toBe(1);
    for (const selector of selectors)
      expect(resolveContextHealthRelationTargetV2(corpus, selector)).toMatchObject({
        state: 'inactive',
        record: {metadata: {memoryId: 'tn_target'}},
      });
    expect(report.findings.every(finding => finding.caseIdentity?.slot === 'tn_target')).toBe(true);
    const conflicting = {...target, uri: 'threadnote://user/me/archive/other-target.md'};
    expect(resolveContextHealthRelationTargetV2([...corpus, conflicting], 'threadnote://memory/tn_target')).toEqual({
      state: 'conflicted',
    });
    expect(resolveContextHealthRelationTargetV2([...corpus, conflicting], target.metadata.archivedFrom!)).toEqual({
      state: 'conflicted',
    });
  });

  it('keeps historical provenance separate from current source and human decisions', () => {
    const source = record('threadnote://memory/historical', 'source', {
      relations: [{type: 'evidence_for', uri: 'threadnote://memory/archived'}],
    });
    const historical = {...receipt('unknown', 'repository-unavailable'), provenance: 'historical-verified' as const};
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [source],
      citationValidations: [{uri: source.uri, receipts: [historical]}],
      relationEvidence: [{sourceUri: source.uri, targetUri: 'threadnote://memory/archived', status: 'inactive'}],
    });
    expect(report.findings).toMatchObject([{category: 'relation-target-inactive', classification: 'historical'}]);
    expect(report.maintenance).toMatchObject({
      actionableFindings: 0,
      historicalFindings: 1,
      citationCoverage: {currentVerified: 0, historicalVerified: 1, checked: 0, state: 'unavailable'},
    });
    expect(report.status).toBe('unknown');
  });

  it('keeps shared structural changes in the authority decision queue', () => {
    const source = record('threadnote://memory/shared', 'source', {
      visibility: 'shared',
      validTo: '2026-09-16',
      relations: [{type: 'depends_on', uri: 'threadnote://memory/missing'}],
    });
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [source],
      relationEvidence: [{sourceUri: source.uri, targetUri: 'threadnote://memory/missing', status: 'missing'}],
    });
    expect(report.maintenance).toMatchObject({
      actionableFindings: 2,
      automaticallyManagedFindings: 0,
      affectedMemories: 1,
    });
  });

  it('reports semantic limits without manufacturing actionable content findings', () => {
    const records = Array.from({length: 130}, (_, index) =>
      record(`threadnote://memory/tn_${index}`, `Unique module claim ${index}.`),
    );
    const report = buildContextHealthReport({now, project: 'threadnote', records});
    expect(report.maintenance?.actionableFindings).toBe(0);
    expect(report.maintenance?.semanticCoverage).toMatchObject({
      state: 'partial',
      eligibleRecords: 130,
      unknownRecords: 2,
    });
    expect(report.status).toBe('unknown');
  });

  it('projects guidance drift onto source memory URIs without a target path', () => {
    const source = record('threadnote://user/me/memories/durable/projects/threadnote/guidance.md', 'guidance');
    const report = buildContextHealthReport({
      guidanceEvidence: [{sourceUris: [source.uri], state: 'locally-modified'}],
      now,
      project: 'threadnote',
      records: [source],
    });
    expect(report.findings).toMatchObject([
      {category: 'guidance-locally-modified', repair: {kind: 'repair-guidance'}, uris: [source.uri]},
    ]);
    expect(JSON.stringify(report)).not.toContain('AGENTS.md');
  });

  it('keeps stale and unavailable guidance evidence when a source is no longer active', () => {
    const source = record('threadnote://user/me/memories/durable/projects/threadnote/retired.md', 'retired', {
      status: 'archived',
    });
    const report = buildContextHealthReport({
      guidanceEvidence: [
        {sourceUris: [source.uri], state: 'stale-sources'},
        {sourceUris: [source.uri], state: 'unavailable'},
      ],
      includeFindingUris: [source.uri],
      now,
      project: 'threadnote',
      records: [source],
    });
    expect(report.findings.map(finding => finding.category)).toEqual([
      'guidance-unavailable',
      'guidance-stale-sources',
    ]);
    expect(report.findings.every(finding => finding.uris.includes(source.uri))).toBe(true);
  });

  it('reports independently actionable health findings from supplied evidence', () => {
    const expired = record('threadnote://user/me/memories/durable/projects/threadnote/expired.md', 'expired', {
      validTo: '2026-09-16T00:00:00.000Z',
    });
    const reviewed = record('threadnote://user/me/memories/durable/projects/threadnote/review.md', 'review', {
      reviewAfter: '2026-09-16',
    });
    const cited = record('threadnote://user/me/memories/durable/projects/threadnote/cited.md', 'citation');
    const related = record('threadnote://user/me/memories/durable/projects/threadnote/related.md', 'relation', {
      relations: [
        {type: 'depends_on', uri: 'threadnote://memory/tn_missing'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_inactive'},
        {type: 'depends_on', uri: 'threadnote://memory/tn_conflicted'},
      ],
    });
    const first = record('threadnote://user/me/memories/durable/projects/threadnote/first.md', 'same body');
    const second = record('threadnote://user/me/memories/durable/projects/threadnote/second.md', 'same body');

    const report = buildContextHealthReport({
      candidateEvidence: [
        {candidateId: 'contradiction', comparison: 'contradiction', project: 'threadnote'},
        {candidateId: 'possible', comparison: 'possible_duplicate', project: 'threadnote'},
      ],
      citationValidations: [
        {
          receipts: [
            receipt('changed', 'source-changed'),
            receipt('deleted', 'source-deleted'),
            receipt('unknown', 'repository-unavailable'),
          ],
          uri: cited.uri,
        },
      ],
      now,
      project: 'threadnote',
      records: [
        second,
        related,
        cited,
        reviewed,
        expired,
        first,
        record('threadnote://user/me/memories/durable/projects/other/other.md', 'other', {project: 'other'}),
      ],
      relationEvidence: [
        {sourceUri: related.uri, status: 'missing', targetUri: 'threadnote://memory/tn_missing'},
        {sourceUri: related.uri, status: 'inactive', targetUri: 'threadnote://memory/tn_inactive'},
        {sourceUri: related.uri, status: 'conflicted', targetUri: 'threadnote://memory/tn_conflicted'},
      ],
    });

    expect(report.findings.map(finding => finding.category)).toEqual([
      'validity-expired',
      'citation-changed',
      'citation-missing',
      'relation-target-missing',
      'relation-target-inactive',
      'relation-target-conflicted',
      'review-overdue',
      'exact-duplicate',
      'candidate-contradiction',
      'candidate-possible-duplicate',
      'citation-unknown',
    ]);
    expect(report.findings.every(finding => finding.repair !== undefined)).toBe(true);
    expect(report.findings.find(finding => finding.category === 'citation-unknown')).toMatchObject({
      confidence: 'low',
      repairability: 'requires-evidence',
    });
    expect(report.recordsScanned).toBe(6);
  });

  it('is deterministic, bounded, and does not mutate inputs', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z]{1,12}$/u), {maxLength: 40}), values => {
        const records = values.map((body, index) =>
          record(`threadnote://user/me/memories/durable/projects/threadnote/${index}.md`, body, {
            validTo: index % 2 === 0 ? '2026-09-16T00:00:00.000Z' : undefined,
          }),
        );
        const original = structuredClone(records);
        const input = {limit: 7, now, project: 'threadnote', records};
        const first = buildContextHealthReport(input);
        const second = buildContextHealthReport({...input, records: [...records].reverse()});
        expect(first).toEqual(second);
        expect(first.findings.length).toBeLessThanOrEqual(7);
        expect(first.omittedFindings).toBeGreaterThanOrEqual(0);
        expect(records).toEqual(original);
      }),
      {numRuns: 50},
    );
  });

  it('applies URI scoping before the finding limit while retaining cross-record evidence', () => {
    fc.assert(
      fc.property(fc.integer({min: 101, max: 180}), unrelatedCount => {
        const affected = record('threadnote://user/me/memories/durable/projects/threadnote/affected.md', 'same body');
        const duplicate = record('threadnote://user/me/memories/durable/projects/threadnote/duplicate.md', 'same body');
        const unrelated = Array.from({length: unrelatedCount}, (_, index) =>
          record(`threadnote://user/me/memories/durable/projects/threadnote/unrelated-${index}.md`, `${index}`, {
            validTo: '2026-09-16T00:00:00.000Z',
          }),
        );
        const duplicateCorpus = [...unrelated, duplicate, affected];
        const broad = buildContextHealthReport({
          duplicateCorpus,
          now,
          project: 'threadnote',
          records: [duplicate, affected],
        });
        const duplicateFinding = broad.findings.find(finding => finding.category === 'exact-duplicate');
        const selected = [duplicate, affected].find(item => item.uri === duplicateFinding?.repair.subjectUri);
        if (selected === undefined) throw new Error('expected exact duplicate subject');
        const report = buildContextHealthReport({
          duplicateCorpus,
          includeFindingUris: [selected.uri],
          now,
          project: 'threadnote',
          records: [selected],
        });

        expect(report.findings).toEqual([expect.objectContaining({category: 'exact-duplicate'})]);
        expect(report.omittedFindings).toBe(0);
      }),
      {numRuns: 20},
    );
  });

  it('uses the full duplicate corpus while admitting only a selected duplicate subject', () => {
    const first = record('threadnote://user/me/memories/durable/projects/threadnote/first.md', 'same body');
    const second = record('threadnote://user/me/memories/durable/projects/threadnote/second.md', 'same body');
    const broad = buildContextHealthReport({now, project: 'threadnote', records: [first, second]});
    const duplicate = broad.findings.find(finding => finding.category === 'exact-duplicate');
    expect(duplicate?.repair.subjectUri).toBeDefined();
    expect(duplicate?.repair.targetUri).toBeDefined();
    const subject = [first, second].find(item => item.uri === duplicate?.repair.subjectUri);
    const survivor = [first, second].find(item => item.uri === duplicate?.repair.targetUri);
    if (subject === undefined || survivor === undefined) throw new Error('expected duplicate subject and survivor');

    const selectedSubject = buildContextHealthReport({
      duplicateCorpus: [first, second],
      includeFindingUris: [subject.uri],
      now,
      project: 'threadnote',
      records: [subject],
    });
    expect(selectedSubject.findings).toEqual([
      expect.objectContaining({
        category: 'exact-duplicate',
        repair: expect.objectContaining({subjectUri: subject.uri, targetUri: survivor.uri}),
      }),
    ]);
    const selectedSurvivor = buildContextHealthReport({
      duplicateCorpus: [first, second],
      includeFindingUris: [survivor.uri],
      now,
      project: 'threadnote',
      records: [survivor],
    });
    expect(selectedSurvivor.findings).toEqual([]);
  });

  it('preserves legacy any-match filtering for internal report consumers', () => {
    const affected = record('threadnote://memory/affected', 'affected', {reviewAfter: '2026-09-16'});
    const unrelated = record('threadnote://memory/unrelated', 'unrelated', {
      relations: [{type: 'depends_on', uri: 'threadnote://memory/conflicted'}],
    });
    const report = buildContextHealthReport({
      includeFindingCategories: ['relation-target-conflicted'],
      includeFindingUris: [affected.uri],
      now,
      project: 'threadnote',
      records: [unrelated, affected],
      relationEvidence: [
        {sourceUri: unrelated.uri, status: 'conflicted', targetUri: 'threadnote://memory/conflicted'},
        {sourceUri: unrelated.uri, status: 'missing', targetUri: 'threadnote://memory/missing'},
      ],
    });

    expect(report.findings.map(finding => finding.category)).toEqual(['relation-target-conflicted', 'review-overdue']);
  });

  it('intersects normalized user selectors across category and URI filters', () => {
    const affected = record('threadnote://memory/affected', 'affected', {reviewAfter: '2026-09-16'});
    const unrelated = record('threadnote://memory/unrelated', 'unrelated', {
      relations: [{type: 'depends_on', uri: 'threadnote://memory/conflicted'}],
    });
    const report = buildContextHealthReport({
      includeFindingCategories: ['relation-target-conflicted'],
      includeFindingCombination: 'all',
      includeFindingUris: [affected.uri],
      now,
      project: 'threadnote',
      records: [unrelated, affected],
      relationEvidence: [
        {sourceUri: unrelated.uri, status: 'conflicted', targetUri: 'threadnote://memory/conflicted'},
        {sourceUri: unrelated.uri, status: 'missing', targetUri: 'threadnote://memory/missing'},
      ],
    });

    expect(report.findings).toEqual([]);
  });
});

function receipt(
  status: 'changed' | 'deleted' | 'unknown',
  reason: 'repository-unavailable' | 'source-changed' | 'source-deleted',
) {
  return {
    candidateCount: 0,
    citationId: `tncc_${status}`,
    coverage: status === 'unknown' ? ('incomplete' as const) : ('current-complete' as const),
    kind: 'file' as const,
    observedAt: now.toISOString(),
    reason,
    status,
    strategy: 'none' as const,
    validatorVersion: 1 as const,
  };
}

function citation(id: string) {
  return {
    id,
    extractorSet: 'fixture',
    fileContentHash: {algorithm: 'sha256' as const, value: '1'.repeat(64)},
    path: 'src/source.ts',
    repositoryId: 'remote:fixture',
    repositoryIdentityKind: 'remote' as const,
    sourceCommit: '2'.repeat(40),
    sourceDirty: false,
    sourceSnapshotId: 'fixture',
    target: {kind: 'file' as const},
    version: 1 as const,
  };
}
