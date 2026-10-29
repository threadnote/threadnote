import {Array as EffectArray, Option as EffectOption} from 'effect';
import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  aggregateCitationFreshness,
  aggregateCitationWarning,
  CONTEXT_BRIEF_CITATION_PERFORMANCE_CONTRACTS,
  contextBriefCitationEvaluationFixtureHash,
  evaluateContextBriefCitationFixture,
  parseContextBriefCitationEvaluationFixtureV1,
  serializeContextBriefCitationEvaluationFixtureIdentity,
  type ContextBriefCitationEvaluationFixtureV1,
  type ContextBriefCitationEvaluationScenarioV1,
  type ContextBriefCitationEvaluationSnapshotState,
  type ContextBriefCitationEvaluationStatus,
  type ContextBriefCitationPerformanceProfileId,
  type ContextBriefCitationPerformanceProfileV1,
} from '@threadnote/threadnote/evaluation/context-brief-citations';

describe('Context Brief citation offline evaluation', () => {
  it('covers the five citation outcomes and passes the approved safety and performance gates', () => {
    const result = evaluateContextBriefCitationFixture(FIXTURE);

    expect(result.gate).toEqual({failures: [], passed: true, version: 1});
    expect(result.quality).toMatchObject({
      aggregateFreshnessAccuracy: 1,
      captureCoverage: 1,
      changedDeletedRecall: 1,
      crossRepositoryLeakageCount: 0,
      falseDeletedFromIncompleteCoverageCount: 0,
      falseFreshRiskCount: 0,
      incrementalCleanMismatchCount: 0,
      legacyParity: 1,
      macroF1: 1,
      nonCurrentAuthoritativeStatusCount: 0,
      relocationPrecision: 1,
      relocationRecall: 1,
      supportedUnknownRate: 0,
      unsupportedUnknownRate: 1,
      warningAccuracy: 1,
    });
    expect(result.quality.confusionMatrix).toEqual(
      expect.arrayContaining([
        {expectedStatus: 'exact', observed: {changed: 0, deleted: 0, exact: 4, relocated: 0, unknown: 0}},
        {expectedStatus: 'relocated', observed: {changed: 0, deleted: 0, exact: 0, relocated: 2, unknown: 0}},
        {expectedStatus: 'changed', observed: {changed: 2, deleted: 0, exact: 0, relocated: 0, unknown: 0}},
        {expectedStatus: 'deleted', observed: {changed: 0, deleted: 1, exact: 0, relocated: 0, unknown: 0}},
        {expectedStatus: 'unknown', observed: {changed: 0, deleted: 0, exact: 0, relocated: 0, unknown: 3}},
      ]),
    );
    expect(EffectArray.map(result.performance, profile => profile.id)).toEqual([
      'local-100k',
      'workset-128',
      'workset-50',
    ]);
    expect(
      EffectOption.getOrUndefined(EffectArray.findFirst(result.performance, profile => profile.id === 'local-100k')),
    ).toMatchObject({
      addedPeakRssBytesMaximum: 32 * 1024 * 1024,
      coldBuilds: 0,
      estimatedTokensMaximum: 1_400,
      maintenanceOperations: 0,
      maximumDatabaseOpenOverage: 0,
    });
  });

  it('keeps relocated evidence fresh while warning that only the link is stale', () => {
    expect(aggregateCitationFreshness(['exact', 'relocated'])).toBe('fresh');
    expect(aggregateCitationWarning(['exact', 'relocated'])).toBe('stale-link');
    expect(aggregateCitationFreshness(['relocated', 'unknown'])).toBe('unknown');
    expect(aggregateCitationWarning(['relocated', 'unknown'])).toBe('unknown-evidence');
    expect(aggregateCitationFreshness(['unknown', 'changed'])).toBe('stale');
    expect(aggregateCitationWarning(['unknown', 'changed'])).toBe('stale-evidence');
  });

  it('blocks false-fresh observations', () => {
    const candidate = replaceScenario(FIXTURE, 'changed', scenario => ({
      ...scenario,
      citations: EffectArray.map(scenario.citations, citation => ({...citation, observedStatus: 'exact'})),
      observedFreshness: 'fresh',
      observedWarning: 'none',
    }));
    const result = evaluateContextBriefCitationFixture(candidate);

    expect(result.quality.falseFreshCitationCount).toBe(1);
    expect(result.quality.falseFreshMemoryCount).toBe(1);
    expect(result.quality.falseFreshRiskCount).toBe(2);
    expect(result.gate.passed).toBe(false);
    expect(result.gate.failures).toContain('false-fresh risk count 2; required 0');
    expect(result.fixture.hash).toBe(contextBriefCitationEvaluationFixtureHash(FIXTURE));
  });

  it('never accepts deleted from incomplete coverage', () => {
    const candidate = replaceScenario(FIXTURE, 'unknown-incomplete', scenario => ({
      ...scenario,
      citations: EffectArray.map(scenario.citations, citation => ({...citation, observedStatus: 'deleted'})),
      observedFreshness: 'stale',
      observedWarning: 'stale-evidence',
    }));
    const result = evaluateContextBriefCitationFixture(candidate);

    expect(result.quality.falseDeletedFromIncompleteCoverageCount).toBe(1);
    expect(result.quality.nonCurrentAuthoritativeStatusCount).toBe(1);
    expect(result.gate.passed).toBe(false);
    expect(result.gate.failures).toContain('deleted statuses from incomplete/unsupported coverage 1; required 0');
  });

  it('ratchets validation latency, total latency, RSS, tokens, database opens, and cold work', () => {
    const candidate: ContextBriefCitationEvaluationFixtureV1 = {
      ...FIXTURE,
      performanceProfiles: EffectArray.map(FIXTURE.performanceProfiles, profile =>
        profile.id !== 'local-100k'
          ? profile
          : {
              ...profile,
              samples: EffectArray.map(profile.samples, sample => ({
                ...sample,
                addedPeakRssBytes: 64 * 1024 * 1024 + 1,
                citationValidationMilliseconds: 251,
                coldBuilds: 1,
                contextBriefMilliseconds: 1_501,
                estimatedTokens: 1_501,
                maintenanceOperations: 1,
                repositoryDatabasesOpened: sample.repositoriesValidated + 1,
              })),
            },
      ),
    };
    const result = evaluateContextBriefCitationFixture(candidate);

    expect(result.gate.passed).toBe(false);
    expect(result.gate.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('local-100k citation-validation p95'),
        expect.stringContaining('local-100k context-brief p95'),
        expect.stringContaining('local-100k added peak RSS'),
        expect.stringContaining('local-100k estimated tokens'),
        expect.stringContaining('local-100k database opens exceeded'),
        'local-100k cold builds 5; required 0',
        'local-100k maintenance operations 5; required 0',
      ]),
    );
  });

  it('rejects fixtures beyond the eight-citation Context Brief memory bound', () => {
    const candidate = replaceScenario(FIXTURE, 'exact', scenario => ({
      ...scenario,
      citations: Array.from({length: 9}, (_, index) => ({
        citationId: `too-many-${index}`,
        expectedStatus: 'exact' as const,
        observedStatus: 'exact' as const,
        support: 'supported' as const,
      })),
    }));

    expect(() => parseContextBriefCitationEvaluationFixtureV1(candidate)).toThrow('exceeds 8 citations');
  });

  it('has order-independent fixture identity, metrics, and gate output', () => {
    const expected = evaluateContextBriefCitationFixture(FIXTURE);
    fc.assert(
      fc.property(
        fc.record({
          profileOffset: fc.nat({max: FIXTURE.performanceProfiles.length - 1}),
          reverseSamples: fc.boolean(),
          scenarioOffset: fc.nat({max: FIXTURE.scenarios.length - 1}),
        }),
        ({profileOffset, reverseSamples, scenarioOffset}) => {
          const reordered: ContextBriefCitationEvaluationFixtureV1 = {
            ...FIXTURE,
            performanceProfiles: EffectArray.map(rotate(FIXTURE.performanceProfiles, profileOffset), profile => ({
              ...profile,
              samples: reverseSamples ? [...profile.samples].reverse() : profile.samples,
            })),
            scenarios: EffectArray.map(rotate(FIXTURE.scenarios, scenarioOffset), scenario => ({
              ...scenario,
              citations: [...scenario.citations].reverse(),
            })),
          };
          expect(contextBriefCitationEvaluationFixtureHash(reordered)).toBe(
            contextBriefCitationEvaluationFixtureHash(FIXTURE),
          );
          expect(serializeContextBriefCitationEvaluationFixtureIdentity(reordered)).toBe(
            serializeContextBriefCitationEvaluationFixtureIdentity(FIXTURE),
          );
          expect(evaluateContextBriefCitationFixture(reordered)).toEqual(expected);
        },
      ),
      {numRuns: 50},
    );
  });

  it('rejects every authoritative status when coverage is incomplete or non-current', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ContextBriefCitationEvaluationSnapshotState>(
          'current-incomplete',
          'stale',
          'deferred',
          'missing',
          'failed',
          'unsupported',
        ),
        fc.constantFrom<Exclude<ContextBriefCitationEvaluationStatus, 'unknown'>>(
          'exact',
          'relocated',
          'changed',
          'deleted',
        ),
        (snapshotState, observedStatus) => {
          const candidate = replaceScenario(FIXTURE, 'unknown-ambiguous-relocation', scenario => ({
            ...scenario,
            citations: EffectArray.map(scenario.citations, citation => ({...citation, observedStatus})),
            snapshotState,
          }));
          const result = evaluateContextBriefCitationFixture(candidate);
          expect(result.quality.nonCurrentAuthoritativeStatusCount).toBe(1);
          expect(result.gate.passed).toBe(false);
          if (
            observedStatus === 'deleted' &&
            (snapshotState === 'current-incomplete' || snapshotState === 'unsupported')
          ) {
            expect(result.quality.falseDeletedFromIncompleteCoverageCount).toBe(1);
          }
        },
      ),
      {numRuns: 50},
    );
  });
});

function scenario(
  input: Omit<ContextBriefCitationEvaluationScenarioV1, 'capture' | 'crossRepositoryLeakage' | 'execution'> &
    Partial<Pick<ContextBriefCitationEvaluationScenarioV1, 'capture' | 'crossRepositoryLeakage' | 'execution'>>,
): ContextBriefCitationEvaluationScenarioV1 {
  return {
    capture: input.capture ?? {eligible: !input.legacy, milliseconds: input.legacy ? 0 : 1, succeeded: !input.legacy},
    citations: input.citations,
    crossRepositoryLeakage: input.crossRepositoryLeakage ?? false,
    ...(input.equivalenceKey === undefined ? {} : {equivalenceKey: input.equivalenceKey}),
    execution: input.execution ?? 'clean',
    expectedFreshness: input.expectedFreshness,
    expectedWarning: input.expectedWarning,
    id: input.id,
    legacy: input.legacy,
    observedFreshness: input.observedFreshness,
    observedWarning: input.observedWarning,
    snapshotState: input.snapshotState,
  };
}

function citation(
  id: string,
  status: ContextBriefCitationEvaluationStatus,
  support: 'supported' | 'unsupported' = 'supported',
) {
  return {citationId: id, expectedStatus: status, observedStatus: status, support} as const;
}

function performanceProfile(
  id: ContextBriefCitationPerformanceProfileId,
  citationValidationMilliseconds: readonly number[],
  contextBriefMilliseconds: readonly number[],
): ContextBriefCitationPerformanceProfileV1 {
  const shape = CONTEXT_BRIEF_CITATION_PERFORMANCE_CONTRACTS[id].shape;
  return {
    id,
    samples: EffectArray.map(citationValidationMilliseconds, (validation, index) => ({
      addedPeakRssBytes: 32 * 1024 * 1024,
      cacheHits: index === 0 ? 0 : Math.floor(shape.citations / 2),
      captureMilliseconds: 20 + index,
      citationValidationMilliseconds: validation,
      citationsCaptured: shape.citations,
      citationsValidated: shape.citations,
      coldBuilds: 0,
      contextBriefMilliseconds: contextBriefMilliseconds[index],
      databaseStatements: shape.citations * 2,
      estimatedTokens: 1_200 + index * 50,
      maintenanceOperations: 0,
      repositoryDatabasesOpened: shape.citedRepositories,
      repositoriesValidated: shape.citedRepositories,
      responseBytes: 3_600 + index * 150,
      sampleId: `sample-${index + 1}`,
    })),
    shape,
  };
}

const FIXTURE: ContextBriefCitationEvaluationFixtureV1 = {
  id: 'context-brief-citations-v1',
  performanceProfiles: [
    performanceProfile('local-100k', [180, 190, 200, 210, 220], [900, 1_000, 1_100, 1_200, 1_300]),
    performanceProfile('workset-50', [350, 375, 400, 425, 450], [2_200, 2_350, 2_500, 2_650, 2_800]),
    performanceProfile('workset-128', [700, 775, 850, 900, 950], [4_000, 4_250, 4_500, 4_700, 4_900]),
  ],
  scenarios: [
    scenario({
      citations: [citation('exact-file', 'exact')],
      expectedFreshness: 'fresh',
      expectedWarning: 'none',
      id: 'exact',
      legacy: false,
      observedFreshness: 'fresh',
      observedWarning: 'none',
      snapshotState: 'current-complete',
    }),
    scenario({
      citations: [citation('relocated-symbol', 'relocated')],
      expectedFreshness: 'fresh',
      expectedWarning: 'stale-link',
      id: 'relocated',
      legacy: false,
      observedFreshness: 'fresh',
      observedWarning: 'stale-link',
      snapshotState: 'current-complete',
    }),
    scenario({
      citations: [citation('changed-symbol', 'changed')],
      expectedFreshness: 'stale',
      expectedWarning: 'stale-evidence',
      id: 'changed',
      legacy: false,
      observedFreshness: 'stale',
      observedWarning: 'stale-evidence',
      snapshotState: 'current-complete',
    }),
    scenario({
      citations: [citation('deleted-file', 'deleted')],
      expectedFreshness: 'stale',
      expectedWarning: 'stale-evidence',
      id: 'deleted',
      legacy: false,
      observedFreshness: 'stale',
      observedWarning: 'stale-evidence',
      snapshotState: 'current-complete',
    }),
    scenario({
      citations: [citation('incomplete-file', 'unknown', 'unsupported')],
      expectedFreshness: 'unknown',
      expectedWarning: 'unknown-evidence',
      id: 'unknown-incomplete',
      legacy: false,
      observedFreshness: 'unknown',
      observedWarning: 'unknown-evidence',
      snapshotState: 'current-incomplete',
    }),
    scenario({
      citations: [citation('ambiguous-symbol', 'unknown', 'unsupported')],
      expectedFreshness: 'unknown',
      expectedWarning: 'unknown-evidence',
      id: 'unknown-ambiguous-relocation',
      legacy: false,
      observedFreshness: 'unknown',
      observedWarning: 'unknown-evidence',
      snapshotState: 'current-complete',
    }),
    scenario({
      citations: [citation('aggregate-changed', 'changed'), citation('aggregate-unknown', 'unknown', 'unsupported')],
      expectedFreshness: 'stale',
      expectedWarning: 'stale-evidence',
      id: 'aggregate-stale-precedence',
      legacy: false,
      observedFreshness: 'stale',
      observedWarning: 'stale-evidence',
      snapshotState: 'current-complete',
    }),
    scenario({
      citations: [citation('aggregate-exact', 'exact'), citation('aggregate-relocated', 'relocated')],
      expectedFreshness: 'fresh',
      expectedWarning: 'stale-link',
      id: 'aggregate-relocated-fresh',
      legacy: false,
      observedFreshness: 'fresh',
      observedWarning: 'stale-link',
      snapshotState: 'current-complete',
    }),
    scenario({
      citations: [],
      expectedFreshness: 'fresh',
      expectedWarning: 'none',
      id: 'legacy-source-commit-parity',
      legacy: true,
      observedFreshness: 'fresh',
      observedWarning: 'none',
      snapshotState: 'current-complete',
    }),
    scenario({
      citations: [citation('parity-symbol', 'exact')],
      equivalenceKey: 'exact-clean-incremental',
      expectedFreshness: 'fresh',
      expectedWarning: 'none',
      id: 'parity-clean',
      legacy: false,
      observedFreshness: 'fresh',
      observedWarning: 'none',
      snapshotState: 'current-complete',
    }),
    scenario({
      citations: [citation('parity-symbol', 'exact')],
      equivalenceKey: 'exact-clean-incremental',
      execution: 'incremental',
      expectedFreshness: 'fresh',
      expectedWarning: 'none',
      id: 'parity-incremental',
      legacy: false,
      observedFreshness: 'fresh',
      observedWarning: 'none',
      snapshotState: 'current-complete',
    }),
  ],
  version: 1,
};

function replaceScenario(
  fixture: ContextBriefCitationEvaluationFixtureV1,
  id: string,
  replace: (scenario: ContextBriefCitationEvaluationScenarioV1) => ContextBriefCitationEvaluationScenarioV1,
): ContextBriefCitationEvaluationFixtureV1 {
  return {
    ...fixture,
    scenarios: EffectArray.map(fixture.scenarios, scenario => (scenario.id === id ? replace(scenario) : scenario)),
  };
}

function rotate<T>(values: readonly T[], offset: number): readonly T[] {
  return [...values.slice(offset), ...values.slice(0, offset)];
}
