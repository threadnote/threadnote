import {Array as EffectArray} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';

import {
  aggregateContextHealthReportsV1,
  buildContextHealthSchedulePlanV1,
  type ContextHealthAggregateSourceV1,
} from '@threadnote/context/health_schedule';
import type {ContextHealthReportV1} from '@threadnote/context/health';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const PROJECT = 'threadnote';
const PERSONAL_REVISION = Effect.pipe('1', EffectString.repeat(64));
const TEAM_REVISION = Effect.pipe('2', EffectString.repeat(64));

describe('context health aggregation and schedule contract', () => {
  it('supports a canonical shared-only aggregate without a personal source', () => {
    const aggregate = aggregateContextHealthReportsV1({
      project: PROJECT,
      teams: [completeTeam('canonical', report(), TEAM_REVISION)],
    });

    expect(aggregate).toMatchObject({completeSources: 1, status: 'clean', unknownSources: 0});
    expect(EffectArray.map(aggregate.sources, source => source.sourceKey)).toEqual(['team:canonical']);
    expect(() => aggregateContextHealthReportsV1({project: PROJECT, teams: []})).toThrow(
      /at least one evidence source/i,
    );
  });

  it('returns clean only when every selected local source has complete evidence', () => {
    const aggregate = aggregateContextHealthReportsV1({
      personal: completePersonal(report()),
      project: PROJECT,
      teams: [completeTeam('platform', report(), TEAM_REVISION)],
    });

    expect(aggregate).toMatchObject({
      completeSources: 2,
      exitCode: 0,
      knownFindings: 0,
      project: PROJECT,
      status: 'clean',
      unknownSources: 0,
      version: 1,
    });
    expect(EffectArray.map(aggregate.sources, source => source.sourceKey)).toEqual(['personal', 'team:platform']);
  });

  it('preserves known findings but reports unknown when any selected source is incomplete', () => {
    const findingReport = report(1);
    const aggregate = aggregateContextHealthReportsV1({
      personal: completePersonal(findingReport),
      project: PROJECT,
      teams: [
        {
          reason: 'snapshot-raced',
          scope: 'team',
          state: 'unknown',
          team: 'platform',
        },
      ],
    });

    expect(aggregate).toMatchObject({
      completeSources: 1,
      exitCode: 2,
      knownFindings: 1,
      status: 'unknown',
      unknownSources: 1,
    });
    expect(aggregate.findings).toEqual([
      expect.objectContaining({findingId: findingReport.findings[0]?.id, sourceKey: 'personal'}),
    ]);
  });

  it('treats a successfully read but evidence-incomplete report as unknown and preserves its revision', () => {
    const incomplete = report();
    const aggregate = aggregateContextHealthReportsV1({
      personal: completePersonal({
        ...incomplete,
        semanticCompleteness: {
          ...incomplete.semanticCompleteness,
          analyzedRecords: 0,
          claimsAnalyzed: 0,
          supportedClaims: 0,
          unsupportedClaims: 0,
          coverage: 'bounded-English-extraction',
          eligibleRecords: 2,
          pairsCompared: 0,
          state: 'unavailable',
          unknownReasons: [{count: 2, reason: 'no-claims'}],
          unknownRecords: 2,
        },
        status: 'unknown',
      }),
      project: PROJECT,
      teams: [],
    });

    expect(aggregate).toMatchObject({exitCode: 2, status: 'unknown', unknownSources: 1});
    expect(aggregate.sources).toEqual([
      {evidenceRevision: PERSONAL_REVISION, reason: 'evidence-incomplete', sourceKey: 'personal', state: 'unknown'},
    ]);
  });

  it('retains independently known structural findings from evidence-incomplete reports', () => {
    const structural = report(1);
    const incomplete = {
      ...structural,
      status: 'unknown' as const,
      semanticCompleteness: {
        ...structural.semanticCompleteness,
        state: 'partial' as const,
        analyzedRecords: 1,
        unknownRecords: 1,
        unknownReasons: [{reason: 'record-limit' as const, count: 1}],
      },
    };
    const aggregate = aggregateContextHealthReportsV1({
      project: PROJECT,
      personal: completePersonal(incomplete),
      teams: [
        {
          scope: 'team',
          team: 'platform',
          state: 'unknown',
          reason: 'citation-evidence-unavailable',
          report: incomplete,
        },
      ],
    });
    expect(aggregate).toMatchObject({knownFindings: 2, status: 'unknown', exitCode: 2, unknownSources: 2});
    expect(EffectArray.map(aggregate.findings, finding => finding.sourceKey)).toEqual(['personal', 'team:platform']);
  });

  it('returns findings only after all selected sources are complete', () => {
    const aggregate = aggregateContextHealthReportsV1({
      personal: completePersonal(report()),
      project: PROJECT,
      teams: [completeTeam('platform', report(2), TEAM_REVISION)],
    });

    expect(aggregate).toMatchObject({exitCode: 1, knownFindings: 2, status: 'findings'});
    expect(EffectArray.every(aggregate.findings, finding => finding.sourceKey === 'team:platform')).toBe(true);
  });

  it('fails closed for duplicate scopes, cross-project reports, and invalid complete revisions', () => {
    expect(() =>
      aggregateContextHealthReportsV1({
        personal: completePersonal(report()),
        project: PROJECT,
        teams: [
          completeTeam('platform', report(), TEAM_REVISION),
          completeTeam('platform', report(), Effect.pipe('3', EffectString.repeat(64))),
        ],
      }),
    ).toThrow(/duplicate team source/i);
    expect(() =>
      aggregateContextHealthReportsV1({
        personal: completePersonal({...report(), project: 'other'}),
        project: PROJECT,
        teams: [],
      }),
    ).toThrow(/another project/i);
    expect(() =>
      aggregateContextHealthReportsV1({
        personal: completePersonal(report(), 'not-a-revision'),
        project: PROJECT,
        teams: [],
      }),
    ).toThrow(/evidence revision/i);
    expect(() =>
      aggregateContextHealthReportsV1({
        personal: completePersonal({...report(), omittedFindings: -1}),
        project: PROJECT,
        teams: [],
      }),
    ).toThrow(/omitted findings/i);
    const invalidVersionReport = {...report(), version: 2};
    expect(() =>
      aggregateContextHealthReportsV1({
        personal: {
          ...completePersonal(report()),
          // @ts-expect-error -- exercise runtime rejection of an unsupported report version.
          report: invalidVersionReport,
        },
        project: PROJECT,
        teams: [],
      }),
    ).toThrow(/version/i);
    const duplicateFinding = report(1).findings[0];
    if (duplicateFinding === undefined) throw new Error('expected one health finding');
    expect(() =>
      aggregateContextHealthReportsV1({
        personal: completePersonal({...report(), findings: [duplicateFinding, duplicateFinding], status: 'findings'}),
        project: PROJECT,
        teams: [],
      }),
    ).toThrow(/duplicate finding/i);
    expect(() =>
      aggregateContextHealthReportsV1({
        personal: completePersonal({
          ...report(1),
          findings: [{...duplicateFinding, id: 'unsafe\nfinding'}],
        }),
        project: PROJECT,
        teams: [],
      }),
    ).toThrow(/finding/i);
    expect(() =>
      aggregateContextHealthReportsV1({
        personal: completePersonal({
          ...report(1),
          findings: [{...duplicateFinding, id: '\0\0'}],
        }),
        project: PROJECT,
        teams: [],
      }),
    ).toThrow(/finding/i);
    const invalidFindingsReport = {...report(), findings: [null]};
    expect(() =>
      aggregateContextHealthReportsV1({
        personal: {
          ...completePersonal(report()),
          // @ts-expect-error -- exercise runtime rejection of a non-record finding.
          report: invalidFindingsReport,
        },
        project: PROJECT,
        teams: [],
      }),
    ).toThrow(/finding/i);
    expect(() =>
      aggregateContextHealthReportsV1({
        personal: completePersonal({...report(1), status: 'clean'}),
        project: PROJECT,
        teams: [],
      }),
    ).toThrow(/report status/i);
    expect(() =>
      aggregateContextHealthReportsV1({
        personal: completePersonal({
          ...report(),
          semanticCompleteness: {...report().semanticCompleteness, analyzedRecords: 1},
        }),
        project: PROJECT,
        teams: [],
      }),
    ).toThrow(/semantic completeness/i);
  });

  it('builds an idempotent provider-neutral read-only invocation plan', () => {
    const plan = buildContextHealthSchedulePlanV1({
      cadenceMinutes: 60,
      project: PROJECT,
      teams: ['runtime', 'platform', 'runtime'],
    });

    expect(plan).toMatchObject({
      cadenceMinutes: 60,
      execution: {network: 'disabled', readOnly: true},
      project: PROJECT,
      resultPolicy: {clean: 0, findings: 1, unknown: 2},
      teams: ['platform', 'runtime'],
      version: 1,
    });
    expect(plan.argv).toEqual([
      'context',
      'health',
      'aggregate',
      '--project',
      PROJECT,
      '--json',
      '--team',
      'platform',
      '--team',
      'runtime',
    ]);
    expect(plan.scheduleId).toMatch(/^context-health-[0-9a-f]{40}$/u);
  });

  it('rejects option-like projects and bounds raw team selectors before normalization', () => {
    expect(() => buildContextHealthSchedulePlanV1({cadenceMinutes: 60, project: '--json', teams: []})).toThrow(
      /project/i,
    );
    expect(() =>
      buildContextHealthSchedulePlanV1({
        cadenceMinutes: 60,
        project: PROJECT,
        teams: Array.from({length: 33}, () => 'platform'),
      }),
    ).toThrow(/at most 32/i);
    expect(() =>
      buildContextHealthSchedulePlanV1({
        cadenceMinutes: 60,
        project: PROJECT,
        teams: [`a${Effect.pipe('b', EffectString.repeat(128))}`],
      }),
    ).toThrow(/team/i);
    expect(() => buildContextHealthSchedulePlanV1({cadenceMinutes: 60, project: 'threadnote/other'})).toThrow(
      /project/i,
    );
  });

  it('represents an invalid configured-team selection as an unambiguous unknown source', () => {
    const aggregate = aggregateContextHealthReportsV1({
      personal: completePersonal(report()),
      project: PROJECT,
      teams: [{reason: 'configured-teams-invalid', scope: 'team-selection', state: 'unknown'}],
    });

    expect(aggregate).toMatchObject({exitCode: 2, status: 'unknown', unknownSources: 1});
    expect(aggregate.sources).toContainEqual({
      reason: 'configured-teams-invalid',
      sourceKey: 'team-selection',
      state: 'unknown',
    });
  });

  it('is invariant to team/source ordering and sensitive to evidence revisions', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/u), {maxLength: 8}),
        fc
          .array(fc.constantFrom(...'0123456789abcdef'), {maxLength: 64, minLength: 64})
          .map(characters => EffectArray.join(characters, '')),
        (teams, revision) => {
          const sources = EffectArray.map(teams, (team, index) => completeTeam(team, report(index % 2), revision));
          const forward = aggregateContextHealthReportsV1({
            personal: completePersonal(report()),
            project: PROJECT,
            teams: sources,
          });
          const reverse = aggregateContextHealthReportsV1({
            personal: completePersonal(report()),
            project: PROJECT,
            teams: [...sources].reverse(),
          });
          expect(reverse).toEqual(forward);
          expect(buildContextHealthSchedulePlanV1({cadenceMinutes: 60, project: PROJECT, teams})).toEqual(
            buildContextHealthSchedulePlanV1({
              cadenceMinutes: 60,
              project: PROJECT,
              teams: [...teams].reverse(),
            }),
          );
        },
      ),
      {numRuns: 50},
    );

    const first = aggregateContextHealthReportsV1({
      personal: completePersonal(report()),
      project: PROJECT,
      teams: [completeTeam('platform', report(), TEAM_REVISION)],
    });
    const changed = aggregateContextHealthReportsV1({
      personal: completePersonal(report()),
      project: PROJECT,
      teams: [completeTeam('platform', report(), Effect.pipe('f', EffectString.repeat(64)))],
    });
    expect(changed.aggregateId).not.toBe(first.aggregateId);
  });
});

function completePersonal(
  healthReport: ContextHealthReportV1,
  evidenceRevision = PERSONAL_REVISION,
): ContextHealthAggregateSourceV1 {
  return {evidenceRevision, report: healthReport, scope: 'personal', state: 'complete'};
}

function completeTeam(
  team: string,
  healthReport: ContextHealthReportV1,
  evidenceRevision: string,
): ContextHealthAggregateSourceV1 {
  return {evidenceRevision, report: healthReport, scope: 'team', state: 'complete', team};
}

function report(findingCount = 0): ContextHealthReportV1 {
  return {
    findings: Array.from({length: findingCount}, (_, index) => ({
      category: 'review-overdue' as const,
      confidence: 'high' as const,
      id: `finding-${index}`,
      repair: {kind: 'review-memory' as const, summary: `Review finding ${index}.`},
      repairability: 'reviewable' as const,
      severity: 'medium' as const,
      summary: `Finding ${index}.`,
      uris: [`threadnote://memory/tn_${index}`],
    })),
    limit: 100,
    omittedFindings: 0,
    project: PROJECT,
    recordsScanned: 2,
    semanticCompleteness: {
      analyzedRecords: 2,
      claimsAnalyzed: 2,
      supportedClaims: 2,
      unsupportedClaims: 0,
      coverage: 'bounded-English-extraction',
      contradictionCount: 0,
      eligibleRecords: 2,
      omittedContradictions: 0,
      pairsCompared: 1,
      state: 'complete',
      unknownReasons: [],
      unknownRecords: 0,
      version: 2,
    },
    status: findingCount > 0 ? 'findings' : 'clean',
    version: 1,
  };
}
