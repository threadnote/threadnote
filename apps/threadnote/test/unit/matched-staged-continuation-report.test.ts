import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  createMatchedStagedContinuationReportV1,
  type MatchedStagedContinuationReportInputV1,
  type MatchedStagedContinuationRowV1,
} from '@threadnote/threadnote/evaluation/matched-staged-continuation-report';

describe('matched staged continuation report', () => {
  it('charges a common Phase 1 failure symmetrically and keeps it in clustered inference', () => {
    const report = createMatchedStagedContinuationReportV1(fixture());

    expect(report.clusters).toBe(5);
    expect(report.commonPhaseFailures).toBe(1);
    expect(report.filesBare.verifiedCompletions).toBe(3);
    expect(report.threadnotePreloadedResume.verifiedCompletions).toBe(3);
    expect(report.filesBare.tokensPerVerifiedCompletion).toBeCloseTo(744_635.6667);
    expect(report.threadnotePreloadedResume.tokensPerVerifiedCompletion).toBe(520_535);
    expect(report.lifecycleTokenReductionPercent).toBeCloseTo(30.0953);
    expect(report.lifecycleTokenReductionPercent95).toEqual({
      low: 14.38555247275345,
      high: 43.033603780458265,
    });
    expect(report.completionDeltaPercentagePoints95).toEqual({low: 0, high: 0});
    expect(report.articleClaimEligible).toBe(true);
  });

  it('rejects one-sided common failures and Threadnote continuations that skip the authored graph query', () => {
    const oneSided = fixture();
    oneSided.rows[0] = {...oneSided.rows[0], failureStage: 'common-phase-one', phaseTwoAttempted: false};
    expect(() => createMatchedStagedContinuationReportV1(oneSided)).toThrow(
      'common failure cannot contain a Phase 2 outcome',
    );

    const skippedGraph = fixture();
    const index = skippedGraph.rows.findIndex(
      row => row.variant === 'threadnote-preloaded-resume' && row.phaseTwoAttempted,
    );
    skippedGraph.rows[index] = {...skippedGraph.rows[index], exactAuthoredGraphQueryFirst: false};
    expect(() => createMatchedStagedContinuationReportV1(skippedGraph)).toThrow('authored graph query first');
  });

  it('keeps results invariant under complete-cluster row ordering', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([0, 1, 2, 3, 4], {minLength: 5, maxLength: 5}), order => {
        const input = fixture();
        const reordered = order.flatMap(index => input.rows.slice(index * 2, index * 2 + 2));
        const report = createMatchedStagedContinuationReportV1({...input, rows: reordered});
        expect(report.lifecycleTokenReductionPercent).toBeCloseTo(30.0953);
        expect(report.lifecycleTokenReductionPercent95).toEqual({
          low: 14.38555247275345,
          high: 43.033603780458265,
        });
      }),
      {numRuns: 20},
    );
  });
});

function fixture(): MatchedStagedContinuationReportInputV1 & {rows: MatchedStagedContinuationRowV1[]} {
  const clusters = [
    ['44268be7b213ff97d2ced8fe', 621_024, 296_282, 182_463, 151_003, true],
    ['4bea6e1792d05abbe31f7e60', 202_023, 202_023, 85_038, 85_038, false],
    ['6b9122dc2e8bfa856ee1b8a0', 487_891, 367_334, 150_423, 161_540, false],
    ['885acb24064eb7b0cc272fb2', 303_530, 255_989, 119_130, 124_853, true],
    ['cc3f356a94428bd425c20a10', 619_439, 439_977, 219_437, 191_173, true],
  ] as const;
  const rows = clusters.flatMap(([id, filesTokens, threadnoteTokens, filesMs, threadnoteMs, verified], index) => {
    const commonFailure = index === 1;
    const common = {
      clusterId: `cluster_${id}`,
      taskId: `tsk_${id}`,
      failureStage: commonFailure ? ('common-phase-one' as const) : ('none' as const),
      phaseTwoAttempted: !commonFailure,
      deterministicVerified: verified,
      hybridVerified: verified,
      valid: true,
      falseCurrentOutcomes: 0,
      authorizationLeaks: 0,
      harmfulActions: 0,
      phaseOneTokens: commonFailure ? filesTokens : 100_000,
      phaseOneMilliseconds: commonFailure ? filesMs : 50_000,
      modelCalls: commonFailure ? 0 : 10,
      toolTurns: commonFailure ? 0 : 8,
      redundantFileReads: 0,
    };
    return [
      {
        ...common,
        variant: 'files-bare' as const,
        runNonce: `run_${String(index * 2).padStart(32, '0')}`,
        phaseTwoTokens: filesTokens - common.phaseOneTokens,
        phaseTwoMilliseconds: filesMs - common.phaseOneMilliseconds,
        mcpToolCallBytes: 0,
        initialContinuationEvidenceState: null,
        exactAuthoredGraphQueryFirst: null,
      },
      {
        ...common,
        variant: 'threadnote-preloaded-resume' as const,
        runNonce: `run_${String(index * 2 + 1).padStart(32, '0')}`,
        phaseTwoTokens: threadnoteTokens - common.phaseOneTokens,
        phaseTwoMilliseconds: threadnoteMs - common.phaseOneMilliseconds,
        mcpToolCallBytes: commonFailure ? 0 : 2_500,
        initialContinuationEvidenceState: commonFailure ? null : ('evidence-bearing' as const),
        exactAuthoredGraphQueryFirst: commonFailure ? null : true,
      },
    ];
  });
  return {
    bootstrap: {
      confidenceLevelBasisPoints: 9_500,
      iterations: 10_000,
      seed: '595e902679e016586b9065d93db48d5317b1d583c1aa8e01b0b93f503150a73f',
    },
    gates: {
      completionNonInferiorityBasisPoints: 500,
      maximumAuthorizationLeaks: 0,
      maximumFalseCurrentOutcomes: 0,
      maximumHarmfulActions: 0,
      minimumClusters: 5,
      minimumTokenReductionBasisPoints: 500,
    },
    rows,
  };
}
