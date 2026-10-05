import fc from 'fast-check';
import {describe, expect, it} from 'vitest';
import {
  createMatchedContinuationOutcomeV1,
  evaluateMatchedContinuationStudyV1,
  parseMatchedContinuationOutcomeV1,
  renderMatchedContinuationArticleEvidenceV1,
  type MatchedContinuationOutcomeV1,
} from '@threadnote/threadnote/evaluation/matched-continuation-report';
import {
  AUTOMATED_CONTEXT_CONTINUATION_VARIANTS,
  createMatchedContinuationStudyV1,
  MATCHED_CONTEXT_CONTINUATION_VARIANTS,
  MATCHED_CONTINUATION_VARIANTS,
  type MatchedContinuationStudyTaskV1,
  type MatchedContinuationVariant,
} from '@threadnote/threadnote/evaluation/matched-continuation-study';

describe('matched continuation claim report', () => {
  it('reports failure-inclusive full-workflow tokens, time, and clustered intervals by variant', () => {
    const study = createStudy();
    const outcomes = createOutcomes(study);

    const report = evaluateMatchedContinuationStudyV1({outcomes, study});
    const files = report.variants.find(result => result.variant === 'files-bare')!;
    const preloaded = report.variants.find(result => result.variant === 'threadnote-preloaded-resume')!;
    const primary = report.comparisons.find(result => result.target === 'threadnote-preloaded-resume')!;

    expect(files.fullLifecycleProviderTokens?.totalTokens).toBe(500);
    expect(files.tokensPerVerifiedCompletion).toBe(100);
    expect(preloaded.fullLifecycleProviderTokens?.totalTokens).toBe(300);
    expect(preloaded.tokensPerVerifiedCompletion).toBe(60);
    expect(report.sharedCheckpointAccounting.providerTokens?.totalTokens).toBe(50);
    expect(primary.tokenReductionPercent).toBe(40);
    expect(primary.tokenReductionPercent95).toEqual({high: 40, low: 40});
    expect(primary.timeReductionPercent).toBe(40);
    expect(primary.completionDeltaPercentagePoints95).toEqual({high: 0, low: 0});
    expect(primary.status).toBe('passed');
    expect(report.supportedClaims).toHaveLength(1);
    expect(report.reportHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(renderMatchedContinuationArticleEvidenceV1(report)).toContain('Raw shared Phase-1 provider tokens: 50');
  });

  it('keeps a failed attempt assigned and refuses to treat missing usage as a cheap workflow', () => {
    const study = createStudy();
    const outcomes = createOutcomes(study, {
      missingUsageFor: new Set(['files-bare:0']),
      statusFor: new Map([['files-bare:0', 'failed']]),
    });

    const report = evaluateMatchedContinuationStudyV1({outcomes, study});
    const files = report.variants.find(result => result.variant === 'files-bare')!;
    const primary = report.comparisons.find(result => result.target === 'threadnote-preloaded-resume')!;

    expect(files.assigned).toBe(5);
    expect(files.failed).toBe(1);
    expect(files.verifiedCompletions).toBe(4);
    expect(files.unassessed).toBe(1);
    expect(files.missingProviderUsage).toBe(1);
    expect(files.tokensPerVerifiedCompletion).toBeNull();
    expect(primary.status).toBe('inconclusive');
    expect(primary.insufficiencies).toContain('failure-inclusive tokens per verified completion are unavailable');
    expect(report.supportedClaims).toHaveLength(0);
  });

  it('binds every outcome to the sealed schedule, task plan, treatment, and hash chain', () => {
    const study = createStudy();
    const outcomes = createOutcomes(study);
    expect(parseMatchedContinuationOutcomeV1(JSON.parse(JSON.stringify(outcomes[0])))).toEqual(outcomes[0]);
    expect(() =>
      evaluateMatchedContinuationStudyV1({
        outcomes: outcomes.map((outcome, index) => (index === 0 ? {...outcome, planSha256: 'f'.repeat(64)} : outcome)),
        study,
      }),
    ).toThrow('outcome hash does not match');
    expect(() =>
      evaluateMatchedContinuationStudyV1({outcomes: [outcomes[1], outcomes[0], ...outcomes.slice(2)], study}),
    ).toThrow('sealed schedule and hash chain');
  });

  it('does not turn an unavailable runtime row into a failed-task confidence interval', () => {
    const study = createStudy();
    const outcomes = createOutcomes(study, {
      statusFor: new Map([['files-bare:0', 'unavailable']]),
    });

    const report = evaluateMatchedContinuationStudyV1({outcomes, study});
    const primary = report.comparisons.find(result => result.target === 'threadnote-preloaded-resume')!;

    expect(primary.completionDeltaPercentagePoints95).toBeNull();
    expect(primary.hybridCompletionDeltaPercentagePoints95).toBeNull();
    expect(primary.completionDeltaPercentagePoints).toBeNull();
    expect(primary.hybridCompletionDeltaPercentagePoints).toBeNull();
    expect(primary.tokenReductionPercent95).toBeNull();
    expect(primary.timeReductionPercent95).toBeNull();
    expect(primary.insufficiencies).toContain(
      'completion intervals are unavailable because the compared matrix has unavailable rows',
    );
    expect(report.supportedClaims).toHaveLength(0);
  });

  it('retains measured cost for a provider-complete row whose verification is unavailable', () => {
    const study = createStudy();
    const outcomes = createOutcomes(study, {
      measuredUnavailableFor: new Set(['files-bare:0']),
      statusFor: new Map([['files-bare:0', 'unavailable']]),
    });

    const report = evaluateMatchedContinuationStudyV1({outcomes, study});
    const files = report.variants.find(result => result.variant === 'files-bare')!;

    expect(files.fullLifecycleProviderTokens?.totalTokens).toBe(500);
    expect(files.missingProviderUsage).toBe(0);
    expect(files.unavailable).toBe(1);
    expect(files.tokensPerVerifiedCompletion).toBe(125);
    expect(report.supportedClaims).toHaveLength(0);
  });

  it('charges measured failed-attempt tokens without calling the failed task a cheap completion', () => {
    const study = createStudy();
    const outcomes = createOutcomes(study, {
      statusFor: new Map([['files-bare:0', 'failed']]),
    });

    const report = evaluateMatchedContinuationStudyV1({outcomes, study});
    const files = report.variants.find(result => result.variant === 'files-bare')!;
    const primary = report.comparisons.find(result => result.target === 'threadnote-preloaded-resume')!;

    expect(files.fullLifecycleProviderTokens?.totalTokens).toBe(500);
    expect(files.verifiedCompletions).toBe(4);
    expect(files.tokensPerVerifiedCompletion).toBe(125);
    expect(primary.tokenReductionPercent).toBe(52);
    expect(primary.completionDeltaPercentagePoints95).not.toBeNull();
    expect(primary.status).toBe('inconclusive');
    expect(primary.insufficiencies).toContain(
      'files-bare has 1 failed or unavailable attempts without safety assessment',
    );
  });

  it('preserves token-reduction estimates when every provider count is scaled uniformly', () => {
    const study = createStudy();
    fc.assert(
      fc.property(fc.integer({min: 1, max: 20}), factor => {
        const report = evaluateMatchedContinuationStudyV1({
          outcomes: createOutcomes(study, {tokenScale: factor}),
          study,
        });
        const primary = report.comparisons.find(result => result.target === 'threadnote-preloaded-resume')!;
        expect(primary.tokenReductionPercent).toBe(40);
        expect(primary.tokenReductionPercent95).toEqual({high: 40, low: 40});
      }),
      {numRuns: 20},
    );
  });

  it('reports a three-arm one-task pilot without promoting it to a claim', () => {
    const study = createStudy({taskCount: 1, variants: MATCHED_CONTEXT_CONTINUATION_VARIANTS});
    const report = evaluateMatchedContinuationStudyV1({outcomes: createOutcomes(study), study});
    const primary = report.comparisons.find(result => result.target === 'threadnote-preloaded-resume')!;

    expect(report.variants.map(result => result.variant)).toEqual(MATCHED_CONTEXT_CONTINUATION_VARIANTS);
    expect(report.comparisons.map(result => result.target)).toEqual(['manual-handoff', 'threadnote-preloaded-resume']);
    expect(primary.tokenReductionPercent).toBe(40);
    expect(primary.status).toBe('inconclusive');
    expect(primary.insufficiencies).toContain('study has 1 repository cluster; 5 required for claim eligibility');
    expect(report.supportedClaims).toEqual([]);
    expect(report.limitations).toContain(
      'Claims apply only to the frozen repositories, tasks, candidate, model configuration, and 3 continuation treatments.',
    );
  });

  it('reports the two-arm automated-context design without a manual-handoff comparison', () => {
    const study = createStudy({taskCount: 2, variants: AUTOMATED_CONTEXT_CONTINUATION_VARIANTS});
    const report = evaluateMatchedContinuationStudyV1({outcomes: createOutcomes(study), study});

    expect(report.variants.map(result => result.variant)).toEqual(AUTOMATED_CONTEXT_CONTINUATION_VARIANTS);
    expect(report.comparisons.map(result => result.target)).toEqual(['threadnote-preloaded-resume']);
    expect(report.primaryComparison).toEqual({baseline: 'files-bare', target: 'threadnote-preloaded-resume'});
    expect(report.limitations).toContain(
      'Claims apply only to the frozen repositories, tasks, candidate, model configuration, and 2 continuation treatments.',
    );
  });

  it('uses deterministic verification when the blinded correctness gate is disabled and discloses order imbalance', () => {
    const study = createStudy({
      minimumCorrectnessScoreMilli: 0,
      taskCount: 5,
      unbalanced: true,
      variants: AUTOMATED_CONTEXT_CONTINUATION_VARIANTS,
    });
    const outcomes = rechainOutcomes(
      createOutcomes(study).map(outcome => ({
        ...outcome,
        assessment: {...outcome.assessment!, correctnessScoreMilli: 0, judgeCompleted: false},
      })),
    );

    const report = evaluateMatchedContinuationStudyV1({outcomes, study});
    const primary = report.comparisons.find(result => result.target === 'threadnote-preloaded-resume')!;
    const preloaded = report.variants.find(result => result.variant === 'threadnote-preloaded-resume')!;

    expect(preloaded.hybridVerifiedCompletions).toBe(preloaded.verifiedCompletions);
    expect(primary.status).toBe('passed');
    expect(report.supportedClaims).toHaveLength(1);
    expect(report.supportedClaims[0]).toContain('token, completion, and safety gates');
    expect(report.limitations).toContain(
      'Attempt order was not position-balanced (files-bare: 5 at position 1, 0 at position 2; threadnote-preloaded-resume: 0 at position 1, 5 at position 2); order effects may influence the paired estimates.',
    );
  });

  it('keeps safety qualification mandatory when the blinded correctness gate is disabled', () => {
    const study = createStudy({
      minimumCorrectnessScoreMilli: 0,
      taskCount: 5,
      variants: AUTOMATED_CONTEXT_CONTINUATION_VARIANTS,
    });
    let injectedSafetyFailure = false;
    const outcomes = rechainOutcomes(
      createOutcomes(study).map(outcome => {
        if (outcome.variant !== 'threadnote-preloaded-resume' || injectedSafetyFailure) return outcome;
        injectedSafetyFailure = true;
        return {
          ...outcome,
          assessment: {...outcome.assessment!, harmfulActions: 1, judgeCompleted: false},
        };
      }),
    );

    const report = evaluateMatchedContinuationStudyV1({outcomes, study});
    const primary = report.comparisons.find(result => result.target === 'threadnote-preloaded-resume')!;
    const preloaded = report.variants.find(result => result.variant === 'threadnote-preloaded-resume')!;

    expect(preloaded.verifiedCompletions).toBe(5);
    expect(preloaded.hybridVerifiedCompletions).toBe(4);
    expect(primary.failures).toContain('threadnote-preloaded-resume exceeded the harmful-action safety gate');
    expect(primary.status).toBe('failed');
    expect(report.supportedClaims).toEqual([]);
  });

  it('reports deterministic completion costs even when the blinded safety assessment fails closed', () => {
    const study = createStudy({taskCount: 1, variants: MATCHED_CONTEXT_CONTINUATION_VARIANTS});
    const outcomes = rechainOutcomes(
      createOutcomes(study).map(outcome =>
        outcome.variant === 'threadnote-preloaded-resume'
          ? {...outcome, assessment: {...outcome.assessment!, harmfulActions: 1, judgeCompleted: false}}
          : outcome,
      ),
    );

    const report = evaluateMatchedContinuationStudyV1({outcomes, study});
    const preloaded = report.variants.find(result => result.variant === 'threadnote-preloaded-resume')!;
    const primary = report.comparisons.find(result => result.target === 'threadnote-preloaded-resume')!;

    expect(preloaded.verifiedCompletions).toBe(1);
    expect(preloaded.hybridVerifiedCompletions).toBe(0);
    expect(preloaded.tokensPerVerifiedCompletion).toBe(60);
    expect(primary.tokenReductionPercent).toBe(40);
    expect(primary.failures).toContain('threadnote-preloaded-resume exceeded the harmful-action safety gate');
    expect(primary.status).toBe('inconclusive');
    expect(report.supportedClaims).toEqual([]);
  });

  it('keeps deterministic accounting invariant under blinded judge and safety outcomes', () => {
    const study = createStudy({taskCount: 1, variants: MATCHED_CONTEXT_CONTINUATION_VARIANTS});
    fc.assert(
      fc.property(
        fc.record({
          authorizationLeaks: fc.integer({min: 0, max: 3}),
          correctnessScoreMilli: fc.integer({min: 0, max: 1_000}),
          falseCurrentOutcomes: fc.integer({min: 0, max: 3}),
          harmfulActions: fc.integer({min: 0, max: 3}),
          judgeCompleted: fc.boolean(),
        }),
        assessmentPatch => {
          const outcomes = rechainOutcomes(
            createOutcomes(study).map(outcome =>
              outcome.variant === 'threadnote-preloaded-resume'
                ? {...outcome, assessment: {...outcome.assessment!, ...assessmentPatch}}
                : outcome,
            ),
          );
          const report = evaluateMatchedContinuationStudyV1({outcomes, study});
          const preloaded = report.variants.find(result => result.variant === 'threadnote-preloaded-resume')!;

          expect(preloaded.verifiedCompletions).toBe(1);
          expect(preloaded.tokensPerVerifiedCompletion).toBe(60);
          expect(preloaded.hybridVerifiedCompletions).toBe(
            assessmentPatch.authorizationLeaks === 0 &&
              assessmentPatch.correctnessScoreMilli === 1_000 &&
              assessmentPatch.falseCurrentOutcomes === 0 &&
              assessmentPatch.harmfulActions === 0 &&
              assessmentPatch.judgeCompleted
              ? 1
              : 0,
          );
        },
      ),
      {numRuns: 32},
    );
  });

  it('does not claim token savings when deterministic completions lack judge-qualified correctness', () => {
    const study = createStudy();
    const outcomes = rechainOutcomes(
      createOutcomes(study).map(outcome => ({
        ...outcome,
        assessment: {...outcome.assessment!, judgeCompleted: false},
      })),
    );

    const report = evaluateMatchedContinuationStudyV1({outcomes, study});
    const primary = report.comparisons.find(result => result.target === 'threadnote-preloaded-resume')!;

    expect(primary.tokenReductionPercent).toBe(40);
    expect(primary.status).toBe('failed');
    expect(primary.failures).toContain(
      'threadnote-preloaded-resume has deterministically verified completions without judge-qualified correctness',
    );
    expect(report.supportedClaims).toEqual([]);
  });

  it('does not promote a one-cluster completion lift to a claim', () => {
    const study = createStudy({taskCount: 1, variants: MATCHED_CONTEXT_CONTINUATION_VARIANTS});
    const outcomes = createOutcomes(study, {
      statusFor: new Map([['files-bare:0', 'failed']]),
    });
    const report = evaluateMatchedContinuationStudyV1({outcomes, study});
    const primary = report.comparisons.find(result => result.target === 'threadnote-preloaded-resume')!;

    expect(primary.completionDeltaPercentagePoints).toBe(100);
    expect(primary.completionDeltaPercentagePoints95).toEqual({high: 100, low: 100});
    expect(primary.status).toBe('inconclusive');
    expect(report.supportedClaims).toEqual([]);
  });
});

function createOutcomes(
  study: ReturnType<typeof createStudy>,
  options: {
    readonly measuredUnavailableFor?: ReadonlySet<string>;
    readonly missingUsageFor?: ReadonlySet<string>;
    readonly statusFor?: ReadonlyMap<string, 'completed' | 'failed' | 'unavailable'>;
    readonly tokenScale?: number;
  } = {},
): readonly MatchedContinuationOutcomeV1[] {
  const totals: Record<MatchedContinuationVariant, number> = {
    'files-bare': 100,
    'manual-handoff': 70,
    'threadnote-graph': 130,
    'threadnote-preloaded-resume': 60,
    'threadnote-resume': 75,
  };
  const scale = options.tokenScale ?? 1;
  let previousOutcomeHash: string | null = null;
  return study.schedule.map(scheduled => {
    const taskIndex = study.tasks.findIndex(task => task.taskId === scheduled.taskId);
    const key = `${scheduled.variant}:${taskIndex}`;
    const status = options.statusFor?.get(key) ?? 'completed';
    const measuredUnavailable = status === 'unavailable' && options.measuredUnavailableFor?.has(key) === true;
    const task = study.tasks[taskIndex];
    const phaseOne = tokens(10 * scale);
    const phaseTwo = options.missingUsageFor?.has(key) ? null : tokens((totals[scheduled.variant] - 10) * scale);
    const outcome = createMatchedContinuationOutcomeV1({
      assessment:
        status === 'completed'
          ? {
              authorizationLeaks: 0,
              blockedActions: 0,
              correctnessScoreMilli: 1_000,
              deterministicVerified: true,
              falseCurrentOutcomes: 0,
              harmfulActions: 0,
              judgeCompleted: true,
              valid: true,
            }
          : null,
      clusterId: task.clusterId,
      evidence: {
        artifactSha256: status === 'completed' || measuredUnavailable ? hex(scheduled.globalRunOrder + 100) : null,
        requestSha256: status === 'completed' || measuredUnavailable ? hex(scheduled.globalRunOrder + 200) : null,
        responseSha256: status === 'completed' || measuredUnavailable ? hex(scheduled.globalRunOrder + 300) : null,
        sourceReportSha256: hex(taskIndex + 400),
        transcriptHash: status === 'completed' || measuredUnavailable ? hex(scheduled.globalRunOrder + 500) : null,
      },
      globalRunOrder: scheduled.globalRunOrder,
      phaseOne: {accountingSource: 'sealed-phase-one', elapsedMilliseconds: 100, providerTokens: phaseOne},
      phaseTwo: {
        accountingSource:
          status === 'completed'
            ? 'observation'
            : status === 'failed'
              ? 'failure-checkpoint'
              : measuredUnavailable
                ? 'verification-unavailable'
                : 'unavailable',
        elapsedMilliseconds:
          status === 'unavailable' && !measuredUnavailable ? null : (totals[scheduled.variant] - 10) * 10,
        providerTokens: status === 'unavailable' && !measuredUnavailable ? null : phaseTwo,
      },
      planSha256: task.planSha256,
      previousOutcomeHash,
      runNonce: scheduled.runNonce,
      status,
      studyHash: study.studyHash,
      taskId: scheduled.taskId,
      underlyingArm: underlyingArm(scheduled.variant),
      variant: scheduled.variant,
      withinTaskRunOrder: scheduled.withinTaskRunOrder,
    });
    previousOutcomeHash = outcome.outcomeHash;
    return outcome;
  });
}

function createStudy(
  options: {
    readonly minimumCorrectnessScoreMilli?: number;
    readonly taskCount?: number;
    readonly unbalanced?: boolean;
    readonly variants?: readonly MatchedContinuationVariant[];
  } = {},
) {
  const variants = options.variants ?? MATCHED_CONTINUATION_VARIANTS;
  const tasks = Array.from({length: options.taskCount ?? 5}, (_, index): MatchedContinuationStudyTaskV1 => ({
    checkpointRepositoryFixtureHash: hex(index + 40),
    checkpointRevision: commit(index + 40),
    clusterId: `cluster_${hex(index + 10).slice(-16)}`,
    planSha256: hex(index + 50),
    repositoryUrl: `https://example.com/org/repository-${index}.git`,
    sourceRepositoryFixtureHash: hex(index + 20),
    sourceRevision: commit(index + 20),
    taskId: `tsk_${hex(index + 30).slice(-16)}`,
  }));
  let globalRunOrder = 0;
  return createMatchedContinuationStudyV1({
    bootstrap: {confidenceLevelBasisPoints: 9_500, iterations: 200, seed: hex(1)},
    candidate: {
      adapterArtifactSha256: hex(2),
      sourceCommit: commit(2),
      toolArtifactHash: hex(3),
      toolVersion: '5.1.0-beta.1.local.test',
    },
    gates: {
      completionNonInferiorityBasisPoints: 500,
      maximumAuthorizationLeaks: 0,
      maximumFalseCurrentOutcomes: 0,
      maximumHarmfulActions: 0,
      minimumClusters: 5,
      minimumCorrectnessScoreMilli: options.minimumCorrectnessScoreMilli ?? 1_000,
      minimumTokenReductionBasisPoints: 500,
    },
    schedule: tasks.flatMap((task, taskIndex) =>
      Array.from({length: variants.length}, (_, position) => {
        const variant = variants[options.unbalanced === true ? position : (position + taskIndex) % variants.length];
        globalRunOrder += 1;
        return {
          globalRunOrder,
          runNonce: `run_${globalRunOrder.toString(16).padStart(32, '0')}`,
          taskId: task.taskId,
          variant,
          withinTaskRunOrder: position + 1,
        };
      }),
    ),
    sourceEvidence: {
      corpusHash: hex(4),
      exposureAuditSha256: hex(9),
      manifestHash: hex(5),
      matchedPreparationReceiptSha256: hex(8),
      matchedStudyHash: hex(6),
      verificationPlanHash: hex(7),
    },
    studyId: 'held-out-continuation-v1',
    tasks,
    variants,
    workflowAccounting: 'phase-one-plus-phase-two-per-attempt',
  });
}

function rechainOutcomes(outcomes: readonly MatchedContinuationOutcomeV1[]): readonly MatchedContinuationOutcomeV1[] {
  let previousOutcomeHash: string | null = null;
  return outcomes.map(outcome => {
    const {outcomeHash: _outcomeHash, version: _version, ...input} = outcome;
    const rechained = createMatchedContinuationOutcomeV1({...input, previousOutcomeHash});
    previousOutcomeHash = rechained.outcomeHash;
    return rechained;
  });
}

function tokens(totalTokens: number) {
  return {cachedInputTokens: 0, inputTokens: totalTokens, outputTokens: 0, reasoningOutputTokens: 0, totalTokens};
}

function underlyingArm(variant: MatchedContinuationVariant) {
  if (variant === 'files-bare' || variant === 'manual-handoff') return 'files' as const;
  if (variant === 'threadnote-graph') return 'threadnote-graph' as const;
  return 'threadnote-compact' as const;
}

function hex(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

function commit(seed: number): string {
  return seed.toString(16).padStart(40, '0');
}
