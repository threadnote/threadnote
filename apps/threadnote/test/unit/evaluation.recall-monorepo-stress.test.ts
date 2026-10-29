import {Array as EffectArray} from 'effect';
import {fcProp} from '@threadnote/testing/fast-check-property';
import {describe, expect, it} from '@effect/vitest';
import * as FC from 'fast-check';
import {
  createMonorepoShareRecallStressFixture,
  MONOREPO_SHARE_RECALL_STRESS_MODES,
  monorepoShareRecallStressCandidates,
  runMonorepoShareRecallStressPass,
  summarizeMonorepoShareRecallStressPass,
  type MonorepoShareRecallStressMode,
  type MonorepoShareRecallStressOptions,
  type MonorepoShareRecallStressScenario,
} from '@threadnote/threadnote/evaluation/recall-monorepo-stress';

function evaluate(
  options: MonorepoShareRecallStressOptions,
  scenario: MonorepoShareRecallStressScenario,
  mode: MonorepoShareRecallStressMode,
) {
  const fixture = createMonorepoShareRecallStressFixture(options, scenario);
  const candidates = monorepoShareRecallStressCandidates(fixture, mode);
  const ranked = runMonorepoShareRecallStressPass(fixture, candidates);
  return {fixture, ranked, summary: summarizeMonorepoShareRecallStressPass(fixture, mode, candidates, ranked)};
}

describe('recall monorepo/share stress fixture', () => {
  it('separates full-corpus, hierarchy-only, and challenger evidence for both target locations', () => {
    const options: MonorepoShareRecallStressOptions = {
      logicalMemoriesPerPackage: 4,
      packages: 3,
      seed: 42,
      shareAliasesPerMemory: 2,
      siblingPackage: 2,
      targetPackage: 1,
      topK: 3,
    };
    const currentFull = evaluate(options, 'current-package-target', 'full-corpus');
    const currentScoped = evaluate(options, 'current-package-target', 'workspace-prefiltered');
    const siblingFull = evaluate(options, 'sibling-package-target', 'full-corpus');
    const siblingScoped = evaluate(options, 'sibling-package-target', 'workspace-prefiltered');
    const siblingChallenger = evaluate(options, 'sibling-package-target', 'cross-scope-challenger');

    expect(createMonorepoShareRecallStressFixture(options)).toEqual(currentFull.fixture);
    expect(EffectArray.every(currentFull.fixture.candidates, candidate => candidate.exactTerms === undefined)).toBe(
      true,
    );
    expect(currentFull.summary).toMatchObject({
      aliasCompressionRate: 2 / 3,
      candidateRecords: 36,
      candidateRepresentation: 'physical-aliases',
      crossScopeRecallAtK: null,
      duplicateResultCount: 0,
      duplicateResultRate: 0,
      logicalCandidates: 12,
      relevantHitsAtK: 1,
      relevantMemories: 1,
      relevantRecallAtK: 1,
      sourceLogicalCandidates: 12,
      sourcePhysicalCandidates: 36,
    });
    expect(currentFull.summary.topMemoryIds[0]).toBe('tn_stress_p001_m0000');
    expect(currentScoped.summary).toMatchObject({
      aliasCompressionRate: 2 / 3,
      candidateRecords: 12,
      logicalCandidates: 4,
      relevantHitsAtK: 1,
      relevantRecallAtK: 1,
    });
    expect(currentScoped.ranked.results[0]?.candidate.equivalentUris).toHaveLength(2);

    expect(siblingFull.summary).toMatchObject({
      crossScopeHitsAtK: 1,
      crossScopeMemories: 1,
      crossScopeRecallAtK: 1,
      relevantRecallAtK: 1,
    });
    expect(siblingScoped.summary).toMatchObject({
      candidateRepresentation: 'physical-aliases',
      crossScopeHitsAtK: 0,
      crossScopeMemories: 1,
      crossScopeRecallAtK: 0,
      relevantRecallAtK: 0,
    });
    expect(siblingChallenger.summary).toMatchObject({
      candidateRepresentation: 'logical-representatives',
      crossScopeHitsAtK: 1,
      crossScopeMemories: 1,
      crossScopeRecallAtK: 1,
      duplicateResultRate: 0,
      relevantRecallAtK: 1,
    });
  });

  it('rescues a sibling-only target from beyond a complete bounded topical head of current-scope decoys', () => {
    const options: MonorepoShareRecallStressOptions = {
      logicalMemoriesPerPackage: 120,
      packages: 3,
      seed: 0x4_02_07,
      shareAliasesPerMemory: 1,
      siblingPackage: 2,
      targetPackage: 0,
      topK: 5,
    };
    const scoped = evaluate(options, 'sibling-package-target', 'workspace-prefiltered');
    const challenger = evaluate(options, 'sibling-package-target', 'cross-scope-challenger');

    expect(scoped.summary.logicalCandidates).toBe(120);
    expect(scoped.summary.crossScopeRecallAtK).toBe(0);
    expect(challenger.summary.admissionLimit).toBe(100);
    expect(challenger.summary.adversarialTopicalRelevantIndex).toBeGreaterThanOrEqual(
      challenger.summary.admissionLimit,
    );
    expect(challenger.summary.candidateRecords).toBe(100);
    expect(challenger.summary.crossScopeRecallAtK).toBe(1);
    expect(challenger.summary.topMemoryIds[0]).toBe('tn_stress_p002_m0000');
  });

  fcProp(
    it,
    'keeps alias shape deterministic while preserving current targets and recovering sibling targets',
    {
      logicalMemoriesPerPackage: FC.integer({max: 16, min: 1}),
      packages: FC.integer({max: 8, min: 2}),
      seed: FC.integer({max: 0x7fff_ffff, min: 1}),
      shareAliasesPerMemory: FC.integer({max: 4, min: 0}),
      targetSelector: FC.integer({max: 1_000, min: 0}),
      siblingOffset: FC.integer({max: 1_000, min: 1}),
      topK: FC.integer({max: 5, min: 1}),
    },
    ({logicalMemoriesPerPackage, packages, seed, shareAliasesPerMemory, siblingOffset, targetSelector, topK}) => {
      const targetPackage = targetSelector % packages;
      const siblingPackage = (targetPackage + 1 + ((siblingOffset - 1) % (packages - 1))) % packages;
      const options: MonorepoShareRecallStressOptions = {
        logicalMemoriesPerPackage,
        packages,
        seed,
        shareAliasesPerMemory,
        siblingPackage,
        targetPackage,
        topK,
      };
      const currentFixture = createMonorepoShareRecallStressFixture(options, 'current-package-target');
      const repeated = createMonorepoShareRecallStressFixture(options, 'current-package-target');
      const currentScoped = evaluate(options, 'current-package-target', 'workspace-prefiltered');
      const siblingScoped = evaluate(options, 'sibling-package-target', 'workspace-prefiltered');
      const siblingChallenger = evaluate(options, 'sibling-package-target', 'cross-scope-challenger');

      expect(currentFixture).toEqual(repeated);
      expect(currentFixture.candidates).toHaveLength(
        packages * logicalMemoriesPerPackage * (shareAliasesPerMemory + 1),
      );
      expect(new Set(EffectArray.map(currentFixture.candidates, candidate => candidate.memoryId)).size).toBe(
        packages * logicalMemoriesPerPackage,
      );
      expect(currentScoped.summary.candidateRecords).toBe(logicalMemoriesPerPackage * (shareAliasesPerMemory + 1));
      expect(currentScoped.summary.logicalCandidates).toBe(logicalMemoriesPerPackage);
      expect(currentScoped.summary.duplicateResultRate).toBe(0);
      expect(currentScoped.summary.relevantRecallAtK).toBe(1);
      expect(currentScoped.summary.topMemoryIds[0]).toBe(currentFixture.relevantMemoryIds[0]);
      expect(siblingScoped.summary.crossScopeRecallAtK).toBe(0);
      expect(siblingChallenger.summary.crossScopeRecallAtK).toBe(1);
      expect(siblingChallenger.summary.duplicateResultRate).toBe(0);
    },
    {fastCheck: {numRuns: 35}},
  );

  it('keeps the public mode ordering stable for comparable artifacts', () => {
    expect(MONOREPO_SHARE_RECALL_STRESS_MODES).toEqual([
      'full-corpus',
      'workspace-prefiltered',
      'cross-scope-challenger',
    ]);
  });
});
