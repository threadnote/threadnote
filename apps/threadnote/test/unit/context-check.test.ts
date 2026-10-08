import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  buildContextHealthReport,
  type ContextHealthFindingV1,
  type ContextHealthReportV1,
} from '@threadnote/context/health';
import type {MemoryRecord} from '@threadnote/memory/document';
import {contextCheckReadFenceIntact, sameChangedPathSelection} from '@threadnote/threadnote/context_check/commands';
import {
  buildContextCheckReport,
  parseContextCheckReportJson,
  projectContextCheckReportSarif,
  serializeContextCheckReportJson,
} from '@threadnote/context/check';

function healthReport(findings: readonly ContextHealthFindingV1[], omittedFindings = 0): ContextHealthReportV1 {
  return {
    findings,
    limit: 100,
    omittedFindings,
    project: 'threadnote',
    recordsScanned: 4,
    semanticCompleteness: {
      analyzedRecords: 4,
      claimsAnalyzed: 4,
      supportedClaims: 4,
      unsupportedClaims: 0,
      coverage: 'bounded-English-extraction',
      contradictionCount: 0,
      eligibleRecords: 4,
      omittedContradictions: 0,
      pairsCompared: 6,
      state: 'complete',
      unknownReasons: [],
      unknownRecords: 0,
      version: 2,
    },
    status: findings.length > 0 || omittedFindings > 0 ? 'findings' : 'clean',
    version: 1,
  };
}

function finding(category: ContextHealthFindingV1['category'], uris: readonly string[]): ContextHealthFindingV1 {
  return {
    category,
    confidence: category === 'citation-unknown' ? 'low' : 'high',
    id: `${category}\u0000${uris.join('\u0000')}`,
    repair: {kind: 'review-memory', summary: 'A reviewable repair.'},
    repairability: category === 'citation-unknown' ? 'requires-evidence' : 'reviewable',
    severity: category === 'citation-unknown' ? 'low' : 'high',
    summary: 'A health finding that intentionally does not contain a memory body.',
    uris,
  };
}

describe('buildContextCheckReport', () => {
  it('rejects a changed-path observation that no longer matches the graph read fence', () => {
    const observed = {
      baseCommit: 'a'.repeat(40),
      caseMode: 'sensitive' as const,
      paths: ['src/changed.ts'],
      repositoryId: 'b'.repeat(64),
      repoRoot: '/repository',
    };
    expect(sameChangedPathSelection(observed, observed)).toBe(true);
    expect(sameChangedPathSelection(observed, {...observed, paths: [...observed.paths, 'src/raced.ts']})).toBe(false);
    const current = {freshness: 'current' as const, readySnapshot: {id: 'snapshot-after'}, stale: false};
    expect(contextCheckReadFenceIntact(observed, observed, 'snapshot-after', current)).toBe(true);
    expect(
      contextCheckReadFenceIntact(
        observed,
        {...observed, paths: [...observed.paths, 'src/raced.ts']},
        'snapshot-after',
        current,
      ),
    ).toBe(false);
    expect(contextCheckReadFenceIntact(observed, observed, 'snapshot-before', current)).toBe(false);
  });

  it('preserves exit classification at every output limit, including zero', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('citation-changed' as const, 'citation-unknown' as const), {maxLength: 30}),
        fc.integer({min: 0, max: 30}),
        fc.option(
          fc.constantFrom('graph-impact-evidence-incomplete' as const, 'graph-impact-evidence-unavailable' as const),
          {nil: undefined},
        ),
        (categories, limit, evidenceReason) => {
          const uris = categories.map((_, index) => `threadnote://memory/${index}`);
          const report = buildContextCheckReport({
            healthReport: healthReport(categories.map((category, index) => finding(category, [uris[index]]))),
            limit,
            selection: {
              affectedMemoryUris: uris,
              changedPaths: ['source.ts'],
              ...(evidenceReason === undefined ? {} : {evidenceReason}),
              status: 'available',
            },
          });
          const expectedExitCode =
            categories.includes('citation-unknown') || (evidenceReason !== undefined && categories.length > 0)
              ? 2
              : categories.length
                ? 1
                : 0;
          expect(report.exitCode).toBe(expectedExitCode);
          expect(report.findings.length + report.omittedFindings).toBe(categories.length);
          if (report.exitCode === 2 && limit === 0) {
            expect(projectContextCheckReportSarif(report).runs[0].results).toEqual([
              expect.objectContaining({ruleId: 'threadnote/context-check/evidence-unavailable'}),
            ]);
          }
          if (evidenceReason !== undefined && categories.length === 0) {
            expect(report).toMatchObject({
              evidenceReason,
              evidenceStatus: 'unavailable',
              exitClassification: 'clean-with-evidence-warning',
              exitCode: 0,
              version: 2,
            });
            expect(projectContextCheckReportSarif(report).runs[0].results).toEqual([
              expect.objectContaining({level: 'warning', ruleId: 'threadnote/context-check/evidence-unavailable'}),
            ]);
          }
        },
      ),
      {numRuns: 60},
    );
  });

  it('does not let a truncated health scan claim clean', () => {
    expect(
      buildContextCheckReport({
        healthReport: healthReport([], 1),
        limit: 0,
        selection: {
          affectedMemoryUris: [],
          changedPaths: [],
          evidenceReason: 'graph-impact-evidence-unavailable',
          status: 'available',
        },
      }),
    ).toMatchObject({evidenceReason: 'health-report-truncated', exitCode: 2});
  });

  it('does not let incomplete semantic evidence claim clean', () => {
    const report = healthReport([]);
    expect(
      buildContextCheckReport({
        healthReport: {
          ...report,
          semanticCompleteness: {
            ...report.semanticCompleteness,
            analyzedRecords: 3,
            state: 'partial',
            unknownReasons: [{count: 1, reason: 'no-claims'}],
            unknownRecords: 1,
          },
          status: 'unknown',
        },
        selection: {
          affectedMemoryUris: ['threadnote://memory/affected'],
          changedPaths: ['src/changed.ts'],
          evidenceReason: 'graph-impact-evidence-incomplete',
          status: 'available',
        },
      }),
    ).toMatchObject({evidenceReason: 'health-report-incomplete', evidenceStatus: 'unavailable', exitCode: 2});
  });

  it('does not require semantic analysis when no memory is selected', () => {
    const filtered = buildContextHealthReport({
      includeFindingUris: ['threadnote://memory/not-present'],
      now: new Date('2026-09-17T00:00:00.000Z'),
      project: 'threadnote',
      records: [duplicateRecord('only-record')],
    });
    expect(filtered).toMatchObject({semanticCompleteness: {state: 'unavailable'}, status: 'unknown'});

    expect(
      buildContextCheckReport({
        healthReport: filtered,
        selection: {affectedMemoryUris: [], changedPaths: ['src/changed.ts'], status: 'available'},
      }),
    ).toMatchObject({evidenceStatus: 'complete', exitClassification: 'clean', exitCode: 0});
  });

  it('keeps actionable findings when semantic evidence is incomplete instead of claiming clean', () => {
    const report = healthReport([finding('citation-changed', ['threadnote://memory/changed'])]);
    expect(
      buildContextCheckReport({
        healthReport: {
          ...report,
          semanticCompleteness: {
            ...report.semanticCompleteness,
            analyzedRecords: 0,
            state: 'unavailable',
            unknownReasons: [{count: 1, reason: 'no-claims'}],
            unknownRecords: 1,
          },
          status: 'unknown',
        },
        selection: {
          affectedMemoryUris: ['threadnote://memory/changed'],
          changedPaths: ['src/changed.ts'],
          status: 'available',
        },
      }),
    ).toMatchObject({evidenceStatus: 'complete', exitCode: 1});
  });

  it('isolates findings to explicitly affected memories and preserves unknown evidence', () => {
    const report = buildContextCheckReport({
      healthReport: healthReport([
        finding('citation-changed', ['threadnote://memory/changed']),
        finding('citation-unknown', ['threadnote://memory/changed']),
        finding('validity-expired', ['threadnote://memory/unaffected']),
      ]),
      selection: {
        affectedMemoryUris: ['threadnote://memory/changed'],
        changedPaths: ['src/changed.ts'],
        status: 'available',
      },
    });

    expect(report.findings.map(item => item.category)).toEqual(['citation-changed', 'citation-unknown']);
    expect(report.exitClassification).toBe('invalid-or-required-evidence-unavailable');
    expect(report.exitCode).toBe(2);
    expect(report.evidenceStatus).toBe('complete');
    expect(JSON.stringify(report)).not.toContain('A health finding');
  });

  it('retains cross-record findings when only one participant is affected', () => {
    const affected = duplicateRecord('affected');
    const unaffected = duplicateRecord('unaffected');
    const report = buildContextCheckReport({
      healthReport: buildContextHealthReport({
        now: new Date('2026-09-17T00:00:00.000Z'),
        project: 'threadnote',
        records: [affected, unaffected],
      }),
      selection: {
        affectedMemoryUris: [affected.uri],
        changedPaths: ['src/affected.ts'],
        status: 'available',
      },
    });

    expect(report.findings).toEqual([expect.objectContaining({category: 'exact-duplicate'})]);
  });

  it('includes exact graph impact, active conflicts, cited-document gaps, and bounded capture advisories', () => {
    const documentUri = 'threadnote://memory/document';
    const graphUri = 'threadnote://memory/graph';
    const report = buildContextCheckReport({
      healthReport: healthReport([
        {
          ...finding('citation-missing', [documentUri]),
          id: 'missing-document',
          repair: {
            kind: 'repair-citation',
            summary: 'Review the missing citation.',
            targetUri: `${documentUri}#tncc_document`,
          },
        },
        {...finding('candidate-contradiction', []), id: 'active-conflict'},
      ]),
      selection: {
        affectedMemoryUris: [documentUri, graphUri],
        captureAdvisoryIds: ['capture-b', 'capture-a'],
        changedPaths: ['docs/guide.md', 'src/source.ts'],
        citedDocumentCitationUris: [`${documentUri}#tncc_document`],
        graphImpactedMemoryUris: [graphUri],
        status: 'available',
      },
    });

    expect(report.findings.map(item => item.category)).toEqual([
      'candidate-contradiction',
      'cited-document-missing',
      'graph-impact',
      'capture-advisory',
      'capture-advisory',
    ]);
    expect(report.exitCode).toBe(1);
    expect(JSON.stringify(report)).not.toContain(documentUri);
    expect(JSON.stringify(report)).not.toContain('docs/guide.md');
  });

  it('reports incomplete graph evidence as unknown while retaining known findings', () => {
    const report = buildContextCheckReport({
      healthReport: healthReport([finding('candidate-contradiction', [])]),
      selection: {
        affectedMemoryUris: [],
        changedPaths: ['src/source.ts'],
        evidenceReason: 'graph-impact-evidence-incomplete',
        status: 'available',
      },
    });

    expect(report).toMatchObject({
      evidenceReason: 'graph-impact-evidence-incomplete',
      evidenceStatus: 'unavailable',
      exitCode: 2,
    });
    expect(report.findings).toEqual([expect.objectContaining({category: 'candidate-contradiction'})]);
  });

  it('treats unavailable graph impact as a non-fatal warning when no findings are known', () => {
    const report = buildContextCheckReport({
      healthReport: healthReport([]),
      selection: {
        affectedMemoryUris: [],
        changedPaths: ['src/source.ts'],
        evidenceReason: 'graph-impact-evidence-unavailable',
        status: 'available',
      },
    });

    expect(report).toMatchObject({
      evidenceReason: 'graph-impact-evidence-unavailable',
      evidenceStatus: 'unavailable',
      exitClassification: 'clean-with-evidence-warning',
      exitCode: 0,
      findings: [],
      version: 2,
    });
  });

  it('reports unavailable affected-memory evidence separately from unknown health findings', () => {
    const report = buildContextCheckReport({
      healthReport: healthReport([finding('citation-changed', ['threadnote://memory/changed'])]),
      selection: {reason: 'affected-memory-evidence-unavailable', status: 'unavailable'},
    });

    expect(report).toMatchObject({
      evidenceStatus: 'unavailable',
      exitClassification: 'invalid-or-required-evidence-unavailable',
      findings: [],
    });
    expect(projectContextCheckReportSarif(report).runs[0]?.results[0]).toMatchObject({
      ruleId: 'threadnote/context-check/evidence-unavailable',
    });
  });

  it('projects deterministic bounded JSON and SARIF without memory bodies', () => {
    const report = buildContextCheckReport({
      limit: 1,
      healthReport: healthReport([
        finding('validity-expired', ['threadnote://memory/a']),
        finding('citation-changed', ['threadnote://memory/b']),
      ]),
      selection: {
        affectedMemoryUris: ['threadnote://memory/b', 'threadnote://memory/a'],
        changedPaths: ['src/b.ts', 'src/a.ts'],
        status: 'available',
      },
    });
    const json = serializeContextCheckReportJson(report);
    const sarif = projectContextCheckReportSarif(report);

    expect(parseContextCheckReportJson(json)).toEqual(report);
    expect(json).not.toContain('threadnote://memory');
    expect(json).not.toContain('A health finding');
    expect(JSON.stringify(sarif)).not.toContain('threadnote://memory');
    expect(JSON.stringify(sarif)).not.toContain('A health finding');
    expect(sarif.runs[0]?.results).toHaveLength(1);
  });

  it('parses legacy v1 graph-gap reports without accepting invalid v2 reports as warnings', () => {
    const current = buildContextCheckReport({
      healthReport: healthReport([]),
      selection: {
        affectedMemoryUris: [],
        changedPaths: ['src/source.ts'],
        evidenceReason: 'graph-impact-evidence-unavailable',
        status: 'available',
      },
    });
    const legacy = {
      ...current,
      exitClassification: 'invalid-or-required-evidence-unavailable',
      exitCode: 2,
      version: 1,
    };

    expect(parseContextCheckReportJson(JSON.stringify(legacy))).toEqual(legacy);
    expect(() =>
      parseContextCheckReportJson(
        JSON.stringify({...current, evidenceStatus: 'invalid', evidenceReason: 'graph-impact-evidence-unavailable'}),
      ),
    ).toThrow('Invalid ContextCheckReport JSON');
  });

  it('rejects excess, out-of-range, and internally inconsistent report JSON', () => {
    const report = buildContextCheckReport({
      healthReport: healthReport([finding('citation-changed', ['threadnote://memory/changed'])]),
      selection: {
        affectedMemoryUris: ['threadnote://memory/changed'],
        changedPaths: ['src/changed.ts'],
        status: 'available',
      },
    });
    for (const invalid of [
      {...report, extra: true},
      {...report, omittedFindings: -1},
      {...report, exitClassification: 'clean', exitCode: 0},
      {...report, findings: [{...report.findings[0], severity: 'severe'}]},
    ]) {
      expect(() => parseContextCheckReportJson(JSON.stringify(invalid))).toThrow('Invalid ContextCheckReport');
    }
  });

  it('has input-order-stable fingerprints, serialization, and affected-set isolation', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,10}$/u), {maxLength: 20}),
        fc.uniqueArray(fc.stringMatching(/^[a-z]{1,10}$/u), {maxLength: 20}),
        (affected, unaffected) => {
          const selectedUris = affected.map(value => `threadnote://memory/${value}`);
          const records = [
            ...selectedUris.map(uri => finding('citation-changed', [uri])),
            ...unaffected.map(value => finding('validity-expired', [`threadnote://memory/other-${value}`])),
          ];
          const input = {
            healthReport: healthReport(records),
            selection: {
              affectedMemoryUris: selectedUris,
              changedPaths: ['src/context.ts'],
              status: 'available' as const,
            },
          };
          const first = buildContextCheckReport(input);
          const second = buildContextCheckReport({
            ...input,
            healthReport: healthReport([...records].reverse()),
            selection: {...input.selection, affectedMemoryUris: [...selectedUris].reverse()},
          });

          expect(first.findings.map(item => item.fingerprint)).toEqual(second.findings.map(item => item.fingerprint));
          expect(parseContextCheckReportJson(serializeContextCheckReportJson(first))).toEqual(first);
          expect(first.findings).toHaveLength(selectedUris.length);
        },
      ),
      {numRuns: 50},
    );
  });
});

function duplicateRecord(name: string): MemoryRecord {
  return {
    body: 'The exact shared invariant.',
    content: 'The exact shared invariant.',
    headerTitle: 'MEMORY',
    metadata: {
      kind: 'durable',
      project: 'threadnote',
      sourceAgentClient: 'test',
      status: 'active',
      timestamp: '2026-09-01T00:00:00.000Z',
      topic: 'exact-duplicate',
    },
    uri: `threadnote://user/test/memories/durable/projects/threadnote/${name}.md`,
  };
}
