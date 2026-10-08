import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {buildContextHealthReport} from '@threadnote/context/health';
import {renderContextHealth} from '@threadnote/threadnote/memory/context/health_commands';
import {MAXIMUM_CONTEXT_HEALTH_SEMANTIC_RECORDS} from '@threadnote/context/health_semantic';
import {previewContextHealthRepairPlanV1} from '@threadnote/threadnote/memory/context/health_repair';
import {
  normalizeContextHealthSelector,
  projectContextHealthRecords,
  type ContextHealthSelectorV1,
} from '@threadnote/threadnote/memory/context/health_selector';
import type {MemoryMetadata, MemoryRecord} from '@threadnote/memory/document';

const now = new Date('2026-09-18T08:00:00.000Z');

describe('context health semantic contradictions', () => {
  it('reports bounded review-only evidence that identifies both records and bounded source claims', () => {
    const required = record('required', '- Agents must load verified context before implementation.');
    const forbidden = record('forbidden', '- Agents must not load verified context before implementation.');
    const report = buildContextHealthReport({now, project: 'threadnote', records: [forbidden, required]});

    expect(report.status).toBe('findings');
    expect(report.semanticCompleteness).toMatchObject({
      analyzedRecords: 2,
      eligibleRecords: 2,
      state: 'complete',
      unknownRecords: 0,
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      category: 'semantic-contradiction',
      confidence: 'low',
      repair: {kind: 'review-memory'},
      repairability: 'manual-review',
      uris: [forbidden.uri, required.uri].sort(),
    });
    expect(report.findings[0]?.semanticEvidence?.left.claimId).toMatch(/^tnclaim_[a-f0-9]{32}$/u);
    expect(report.findings[0]?.semanticEvidence?.right.claimId).toMatch(/^tnclaim_[a-f0-9]{32}$/u);
    const serialized = JSON.stringify(report);
    expect(serialized).toContain('Agents must');
    expect(serialized.length).toBeLessThan(8_000);
  });

  it('uses plain review summaries while keeping distinct revision-bound finding IDs', () => {
    const left = record('left', '# Production\nTimeout is 30 seconds.\nTimeout is 40 seconds.');
    const right = record('right', '# Production\nTimeout is 60 seconds.');
    const report = buildContextHealthReport({now, project: 'threadnote', records: [left, right]});
    expect(report.findings).toHaveLength(2);
    expect(new Set(report.findings.map(finding => finding.id)).size).toBe(2);
    for (const finding of report.findings) {
      expect(finding.summary).toBe('Conflicting timeout values require review. Applicability needs context.');
      expect(finding.summary).not.toMatch(/tnclaim_|incompatible-values|uncertain-comparison/u);
      expect(finding.semanticEvidence?.left.claimId).toMatch(/^tnclaim_/u);
    }
  });
  it('reports missing or bounded-away evidence as unknown and never clean', () => {
    const missing = record('missing', '# Heading only');
    const unavailable = buildContextHealthReport({now, project: 'threadnote', records: [missing]});
    expect(unavailable.status).toBe('unknown');
    expect(unavailable.semanticCompleteness).toMatchObject({
      analyzedRecords: 0,
      eligibleRecords: 1,
      state: 'unavailable',
      unknownRecords: 1,
      unknownReasons: [{count: 1, reason: 'no-claims'}],
    });
    expect(renderContextHealth(unavailable)).toContain('Semantic unknown evidence: no-claims=1.');
    const partialWithFinding = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [
        missing,
        record('positive', 'Memory retrieval must use verified context.'),
        record('negative', 'Memory retrieval must not use verified context.'),
      ],
    });
    expect(partialWithFinding.status).toBe('unknown');
    expect(partialWithFinding.findings).toEqual([expect.objectContaining({category: 'semantic-contradiction'})]);

    const records = Array.from({length: MAXIMUM_CONTEXT_HEALTH_SEMANTIC_RECORDS + 3}, (_, index) =>
      record(`bounded-${index}`, `Memory ${index} must retain deterministic evidence.`),
    );
    const partial = buildContextHealthReport({now, project: 'threadnote', records});
    expect(partial.status).toBe('unknown');
    expect(partial.semanticCompleteness).toMatchObject({
      eligibleRecords: records.length,
      state: 'unavailable',
      unknownRecords: 131,
    });
    expect(partial.semanticCompleteness.unknownReasons).toContainEqual({count: 3, reason: 'record-limit'});
  });

  it('keeps the large bounded-report contract while selectors can isolate a maintenance scope', () => {
    const {records} = largeHealthFixture();
    const report = buildContextHealthReport({now, project: 'threadnote', records});

    expect(report).toMatchObject({
      findings: expect.any(Array),
      nextCursor: expect.stringMatching(/^hcx1_[0-9a-z]+_[0-9a-f]{40}$/u),
      omittedFindings: 1_981,
      recordsScanned: 2_128,
      status: 'unknown',
      version: 1,
    });
    expect(report.findings).toHaveLength(100);
    expect(report.semanticCompleteness).toMatchObject({
      analyzedRecords: 0,
      claimsAnalyzed: 256,
      eligibleRecords: 302,
      unknownRecords: 302,
      unknownReasons: expect.arrayContaining([
        {count: 112, reason: 'claim-budget'},
        {count: 174, reason: 'record-limit'},
      ]),
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(projectContextHealthRecords(records, {kind: 'durable'})).toHaveLength(302);
    expect(projectContextHealthRecords(records, {kind: 'handoff'})).toHaveLength(1_826);
    expect(projectContextHealthRecords(records, {topic: 'durable-10'})).toHaveLength(1);

    const exactSelector = normalizeContextHealthSelector({
      findingCategory: 'validity-expired',
      kind: 'handoff',
      topic: 'handoff-overflow',
    });
    const exact = selectedReport(records, exactSelector);
    expect(exact).toMatchObject({omittedFindings: 1_679, recordsScanned: 1_779, remainingFindings: 1_679});
    expect(exact.findings).toHaveLength(100);
    expect(exact.findings.every(finding => finding.category === 'validity-expired')).toBe(true);
    const second = selectedReport(records, {...exactSelector, after: exact.nextCursor});
    expect(second.findings).toHaveLength(100);
    expect(new Set(second.findings.map(finding => finding.id))).not.toEqual(
      new Set(exact.findings.map(finding => finding.id)),
    );
    expect(second.findings.some(finding => exact.findings.some(first => first.id === finding.id))).toBe(false);
    expect(second.omittedFindings).toBe(1_679);
    expect(second.remainingFindings).toBe(1_579);
    expect(second.findings.length + second.omittedFindings).toBe(1_779);

    const reversed = selectedReport([...records].reverse(), exactSelector);
    expect(reversed.nextCursor).toBe(exact.nextCursor);
    expect(reversed.findings).toEqual(exact.findings);
    expect(() => selectedReport(records, {...exactSelector, after: `hcx1_2s_${'0'.repeat(40)}`})).toThrow(
      'invalid or stale',
    );
    const changed = records.map((item, index) =>
      index === 400 ? {...item, content: `${item.content}\nchanged`} : item,
    );
    expect(() => selectedReport(changed, {...exactSelector, after: exact.nextCursor})).toThrow('invalid or stale');

    const seen = new Set(exact.findings.map(finding => finding.id));
    let page = second;
    for (;;) {
      for (const finding of page.findings) {
        expect(seen.has(finding.id)).toBe(false);
        seen.add(finding.id);
      }
      expect(page.findings.length + page.omittedFindings).toBe(1_779);
      if (page.nextCursor === undefined) break;
      page = selectedReport(records, {...exactSelector, after: page.nextCursor});
    }
    expect(seen.size).toBe(1_779);
    expect(page.remainingFindings).toBe(0);

    const categoryOnly = selectedReport(records, {findingCategory: 'validity-expired'});
    expect(exact.findings.length + exact.omittedFindings).toBeLessThanOrEqual(
      categoryOnly.findings.length + categoryOnly.omittedFindings,
    );
    const rendered = renderContextHealth(exact, exactSelector);
    expect(rendered).toContain('Continue this exact scope without duplicates:');
    expect(rendered).toContain(`--after ${exact.nextCursor}`);
    expect(rendered).toContain('--finding-category validity-expired --kind handoff --topic handoff-overflow');
  });

  it('groups large text reports with total counts, owning memories, and actionable next steps', () => {
    const report = buildContextHealthReport({now, project: 'threadnote', records: largeHealthFixture().records});
    const rendered = renderContextHealth(report);

    expect(rendered).toContain(
      `Context health for threadnote: ${report.maintenance!.affectedMemories} memories need decisions; ${report.maintenance!.automaticallyManagedFindings} automatically managed findings; 2128 active records.`,
    );
    expect(rendered).not.toContain('100 critical validity-expired');
    expect(rendered).not.toContain('Preview 100 reviewable findings');
    expect(rendered).toContain(
      'Maintenance progress: threadnote context maintain --action status --project threadnote',
    );
    expect(rendered).toContain(`threadnote context health --project threadnote --after ${report.nextCursor}`);
    expect(rendered.split('\n').length).toBeLessThan(20);
  });

  it('admits project-global evidence only when the exact selected URI owns it or category alone selects it', () => {
    const selected = record('selected', 'Synthetic selected record.', {
      topic: 'selected',
      validTo: '2026-09-16T00:00:00.000Z',
    });
    const unrelatedUri = 'threadnote://user/test/memories/durable/projects/threadnote/unrelated.md';
    const evidence = {
      candidateEvidence: [
        {
          candidateId: 'candidate-unrelated',
          comparison: 'contradiction' as const,
          project: 'threadnote',
          targetUri: unrelatedUri,
        },
      ],
      guidanceEvidence: [{sourceUris: [unrelatedUri], state: 'stale-sources' as const}],
    };
    const selectedOnly = buildContextHealthReport({
      ...evidence,
      includeFindingUris: [selected.uri],
      now,
      project: 'threadnote',
      records: [selected],
    });
    expect(selectedOnly.findings.map(finding => finding.category)).toEqual(['validity-expired']);

    const categoryOnly = buildContextHealthReport({
      ...evidence,
      includeFindingCategories: ['candidate-contradiction'],
      now,
      project: 'threadnote',
      records: [selected],
    });
    expect(categoryOnly.findings).toEqual([expect.objectContaining({category: 'candidate-contradiction'})]);
    const strictIntersection = buildContextHealthReport({
      ...evidence,
      includeFindingCategories: ['candidate-contradiction'],
      includeFindingCombination: 'all',
      includeFindingUris: [selected.uri],
      now,
      project: 'threadnote',
      records: [selected],
    });
    expect(strictIntersection.findings).toEqual([]);
  });

  it('marks broad lexical negation as uncertain and review-only', () => {
    const lexicalNegation = record('lexical-negation', 'No agents bypass signed artifacts.');
    const equivalentQuantifier = record('equivalent-quantifier', 'Zero agents bypass signed artifacts.');
    const report = buildContextHealthReport({
      now,
      project: 'threadnote',
      records: [lexicalNegation, equivalentQuantifier],
    });

    // Unsupported lexical similarities are uncertain review evidence.
    expect(report.findings).toEqual([
      expect.objectContaining({
        category: 'semantic-contradiction',
        semanticEvidence: expect.objectContaining({classification: 'uncertain-comparison'}),
        confidence: 'low',
        repair: expect.objectContaining({kind: 'review-memory'}),
        repairability: 'manual-review',
      }),
    ]);
    expect(previewContextHealthRepairPlanV1(report, [lexicalNegation, equivalentQuantifier]).proposals).toEqual([
      expect.objectContaining({mutation: expect.objectContaining({kind: 'review-only'})}),
    ]);
  });

  it('never treats lexical contradiction ordering as stale/current direction', () => {
    const lexicallyFirstCurrent = record('a-current', 'Agents must reuse verified context.', {
      memoryId: 'tn_current',
    });
    const lexicallyLastStale = record('z-stale', 'Agents must not reuse verified context.', {
      memoryId: 'tn_stale',
    });

    for (const records of [
      [lexicallyFirstCurrent, lexicallyLastStale],
      [lexicallyLastStale, lexicallyFirstCurrent],
    ]) {
      const report = buildContextHealthReport({now, project: 'threadnote', records});
      expect(report.findings[0]?.repair).toEqual({
        kind: 'review-memory',
        summary:
          'Review both source claims, scope, validity, and roles; preserve compatible rules and history. No source wins automatically.',
      });
      const proposal = previewContextHealthRepairPlanV1(report, records).proposals[0];
      expect(proposal?.mutation).toMatchObject({kind: 'review-only'});
      if (proposal?.mutation.kind !== 'review-only') throw new Error('expected neutral review-only proposal');
      expect(proposal.mutation.suggestedMutation).toBeUndefined();
      expect(proposal.preconditions).toEqual([]);
    }
  });

  it('keeps record-selected reports deterministic and non-mutating', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.stringMatching(/^[a-z]{3,12}$/u), {minLength: 1, maxLength: 24}), subjects => {
        const records = subjects.map((subject, index) =>
          record(subject, 'Synthetic maintenance record.', {
            kind: index % 2 === 0 ? 'durable' : 'handoff',
            topic: index % 3 === 0 ? 'selected' : 'other',
            validTo: '2026-09-16T00:00:00.000Z',
          }),
        );
        const original = structuredClone(records);
        const selector = {kind: 'durable' as const, topic: 'selected'};
        const first = buildContextHealthReport({
          now,
          project: 'threadnote',
          records: projectContextHealthRecords(records, selector),
        });
        const second = buildContextHealthReport({
          now,
          project: 'threadnote',
          records: projectContextHealthRecords([...records].reverse(), selector),
        });
        expect(second).toEqual(first);
        expect(records).toEqual(original);
      }),
      {numRuns: 50},
    );
  });
});

function record(name: string, body: string, metadata: Partial<MemoryMetadata> = {}): MemoryRecord {
  return {
    body,
    content: body,
    headerTitle: metadata.kind === 'handoff' ? 'HANDOFF' : 'MEMORY',
    metadata: {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-09-18T00:00:00.000Z',
      topic: name,
      ...metadata,
    },
    uri: `threadnote://user/test/memories/durable/projects/${metadata.project ?? 'threadnote'}/${name}.md`,
  };
}

function largeHealthFixture(): {readonly records: readonly MemoryRecord[]} {
  const durable = Array.from({length: 302}, (_, recordIndex) =>
    record(
      `durable-${recordIndex.toString().padStart(4, '0')}`,
      Array.from(
        {length: 16},
        (_, claimIndex) => `Synthetic policy ${recordIndex} claim ${claimIndex} retains bounded evidence.`,
      ).join('\n'),
      {topic: `durable-${recordIndex}`, validTo: '2026-09-16T00:00:00.000Z'},
    ),
  );
  const findingHandoffs = Array.from({length: 1_779}, (_, recordIndex) =>
    record(`handoff-${recordIndex.toString().padStart(4, '0')}`, 'Synthetic handoff maintenance note.', {
      kind: 'handoff',
      topic: 'handoff-overflow',
      validTo: '2026-09-16T00:00:00.000Z',
    }),
  );
  const cleanHandoffs = Array.from({length: 47}, (_, recordIndex) =>
    record(`clean-${recordIndex.toString().padStart(4, '0')}`, `Synthetic clean non-durable note ${recordIndex}.`, {
      kind: 'handoff',
      topic: 'clean-handoff',
    }),
  );
  return {records: [...durable, ...findingHandoffs, ...cleanHandoffs]};
}

function selectedReport(records: readonly MemoryRecord[], selector: ContextHealthSelectorV1 | undefined) {
  const selected = projectContextHealthRecords(records, selector);
  const hasRecordSelector = selector?.kind !== undefined || selector?.topic !== undefined;
  return buildContextHealthReport({
    after: selector?.after,
    ...(selector?.findingCategory === undefined ? {} : {includeFindingCategories: [selector.findingCategory]}),
    ...(selector === undefined ? {} : {includeFindingCombination: 'all' as const}),
    ...(hasRecordSelector ? {includeFindingUris: selected.map(item => item.uri)} : {}),
    now,
    project: 'threadnote',
    records: selected,
  });
}
