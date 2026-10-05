import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  parseMatchedContinuationStudyV1,
  MATCHED_CONTINUATION_VARIANTS,
  type MatchedContinuationStudyV1,
  type MatchedContinuationVariant,
} from './matched-continuation-study.js';
import type {MatchedEvaluationProviderTokensV1} from './matched-evaluation-runner.js';

export const MATCHED_CONTINUATION_OUTCOME_VERSION = 1 as const;
export const MATCHED_CONTINUATION_REPORT_VERSION = 1 as const;

export interface MatchedContinuationOutcomeV1 {
  readonly assessment: {
    readonly authorizationLeaks: number;
    readonly blockedActions: number;
    readonly correctnessScoreMilli: number;
    readonly deterministicVerified: boolean;
    readonly falseCurrentOutcomes: number;
    readonly harmfulActions: number;
    readonly judgeCompleted: boolean;
    readonly valid: boolean;
  } | null;
  readonly clusterId: string;
  readonly evidence: {
    readonly artifactSha256: string | null;
    readonly requestSha256: string | null;
    readonly responseSha256: string | null;
    readonly sourceReportSha256: string;
    readonly transcriptHash: string | null;
  };
  readonly globalRunOrder: number;
  readonly outcomeHash: string;
  readonly phaseOne: MatchedContinuationAccountingV1;
  readonly phaseTwo: MatchedContinuationAccountingV1;
  readonly planSha256: string;
  readonly previousOutcomeHash: string | null;
  readonly runNonce: string;
  readonly status: 'completed' | 'failed' | 'unavailable';
  readonly studyHash: string;
  readonly taskId: string;
  readonly underlyingArm: 'files' | 'threadnote-graph' | 'threadnote-compact';
  readonly variant: MatchedContinuationVariant;
  readonly version: typeof MATCHED_CONTINUATION_OUTCOME_VERSION;
  readonly withinTaskRunOrder: number;
}

export interface MatchedContinuationAccountingV1 {
  readonly accountingSource:
    'sealed-phase-one' | 'observation' | 'failure-checkpoint' | 'verification-unavailable' | 'unavailable';
  readonly elapsedMilliseconds: number | null;
  readonly providerTokens: MatchedEvaluationProviderTokensV1 | null;
}

export interface MatchedContinuationVariantResultV1 {
  readonly assigned: number;
  readonly authorizationLeaks: number;
  readonly completed: number;
  readonly failed: number;
  readonly falseCurrentOutcomes: number;
  readonly fullLifecycleMilliseconds: number | null;
  readonly fullLifecycleMillisecondsPerVerifiedCompletion: number | null;
  readonly fullLifecycleProviderTokens: MatchedEvaluationProviderTokensV1 | null;
  readonly harmfulActions: number;
  readonly hybridVerifiedCompletions: number;
  readonly invalid: number;
  readonly missingElapsedAccounting: number;
  readonly missingProviderUsage: number;
  readonly phaseOneElapsedMilliseconds: number | null;
  readonly phaseOneProviderTokens: MatchedEvaluationProviderTokensV1 | null;
  readonly phaseTwoElapsedMilliseconds: number | null;
  readonly phaseTwoProviderTokens: MatchedEvaluationProviderTokensV1 | null;
  readonly unassessed: number;
  readonly unavailable: number;
  readonly variant: MatchedContinuationVariant;
  readonly verifiedCompletionRate: number;
  readonly verifiedCompletions: number;
  readonly tokensPerVerifiedCompletion: number | null;
}

export interface MatchedContinuationIntervalV1 {
  readonly high: number;
  readonly low: number;
}

export interface MatchedContinuationComparisonV1 {
  readonly baseline: 'files-bare';
  readonly completionDeltaPercentagePoints: number | null;
  readonly completionDeltaPercentagePoints95: MatchedContinuationIntervalV1 | null;
  readonly failures: readonly string[];
  readonly hybridCompletionDeltaPercentagePoints: number | null;
  readonly hybridCompletionDeltaPercentagePoints95: MatchedContinuationIntervalV1 | null;
  readonly insufficiencies: readonly string[];
  readonly status: 'failed' | 'inconclusive' | 'passed';
  readonly target: Exclude<MatchedContinuationVariant, 'files-bare'>;
  readonly timeReductionPercent: number | null;
  readonly timeReductionPercent95: MatchedContinuationIntervalV1 | null;
  readonly tokenReductionPercent: number | null;
  readonly tokenReductionPercent95: MatchedContinuationIntervalV1 | null;
}

export interface MatchedContinuationReportV1 {
  readonly comparisons: readonly MatchedContinuationComparisonV1[];
  readonly limitations: readonly string[];
  readonly primaryComparison: {
    readonly baseline: 'files-bare';
    readonly target: 'threadnote-preloaded-resume';
  };
  readonly reportHash: string;
  readonly sharedCheckpointAccounting: {
    readonly elapsedMilliseconds: number | null;
    readonly providerTokens: MatchedEvaluationProviderTokensV1 | null;
  };
  readonly sourceEvidence: MatchedContinuationStudyV1['sourceEvidence'];
  readonly studyHash: string;
  readonly supportedClaims: readonly string[];
  readonly variants: readonly MatchedContinuationVariantResultV1[];
  readonly version: typeof MATCHED_CONTINUATION_REPORT_VERSION;
  readonly workflowAccounting: 'phase-one-plus-phase-two-per-attempt';
}

const HASH = /^[0-9a-f]{64}$/u;
const CLUSTER_ID = /^cluster_[0-9a-f]{16,64}$/u;
const RUN_NONCE = /^run_[0-9a-f]{32}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const ZERO_TOKENS: MatchedEvaluationProviderTokensV1 = Object.freeze({
  cachedInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
});

export function createMatchedContinuationOutcomeV1(
  input: Omit<MatchedContinuationOutcomeV1, 'outcomeHash' | 'version'>,
): MatchedContinuationOutcomeV1 {
  const normalized = parseOutcomeWithoutHash(input);
  return {
    ...normalized,
    outcomeHash: outcomeHash(normalized),
    version: MATCHED_CONTINUATION_OUTCOME_VERSION,
  };
}

export function parseMatchedContinuationOutcomeV1(value: unknown): MatchedContinuationOutcomeV1 {
  const outcome = object(value, 'continuation outcome');
  exactKeys(
    outcome,
    [
      'assessment',
      'clusterId',
      'evidence',
      'globalRunOrder',
      'outcomeHash',
      'phaseOne',
      'phaseTwo',
      'planSha256',
      'previousOutcomeHash',
      'runNonce',
      'status',
      'studyHash',
      'taskId',
      'underlyingArm',
      'variant',
      'version',
      'withinTaskRunOrder',
    ],
    'continuation outcome',
  );
  if (outcome.version !== MATCHED_CONTINUATION_OUTCOME_VERSION) invalid('outcome version must be 1');
  const normalized = parseOutcomeWithoutHash(outcome);
  const hash = matchingString(outcome.outcomeHash, HASH, 'continuation outcome hash');
  if (hash !== outcomeHash(normalized)) invalid('outcome hash does not match its contents');
  return {...normalized, outcomeHash: hash, version: MATCHED_CONTINUATION_OUTCOME_VERSION};
}

export function assertMatchedContinuationOutcomeLedgerV1(
  studyInput: MatchedContinuationStudyV1 | unknown,
  outcomesInput: readonly MatchedContinuationOutcomeV1[] | readonly unknown[],
): readonly MatchedContinuationOutcomeV1[] {
  const study = parseMatchedContinuationStudyV1(studyInput);
  if (outcomesInput.length > study.schedule.length) invalid('outcome ledger is longer than the study schedule');
  let previous: string | null = null;
  return outcomesInput.map((input, index) => {
    const outcome = parseMatchedContinuationOutcomeV1(input);
    const scheduled = study.schedule[index];
    if (
      outcome.studyHash !== study.studyHash ||
      outcome.globalRunOrder !== scheduled.globalRunOrder ||
      outcome.runNonce !== scheduled.runNonce ||
      outcome.taskId !== scheduled.taskId ||
      outcome.variant !== scheduled.variant ||
      outcome.withinTaskRunOrder !== scheduled.withinTaskRunOrder ||
      outcome.previousOutcomeHash !== previous
    ) {
      invalid(`outcome ${index} does not match the sealed schedule and hash chain`);
    }
    const task = required(study.tasks.find(candidate => candidate.taskId === outcome.taskId));
    if (
      outcome.clusterId !== task.clusterId ||
      outcome.planSha256 !== task.planSha256 ||
      outcome.underlyingArm !== underlyingArm(outcome.variant)
    ) {
      invalid(`outcome ${index} differs from its sealed task or treatment`);
    }
    previous = outcome.outcomeHash;
    return outcome;
  });
}

export function evaluateMatchedContinuationStudyV1(input: {
  readonly outcomes: readonly MatchedContinuationOutcomeV1[] | readonly unknown[];
  readonly study: MatchedContinuationStudyV1 | unknown;
}): MatchedContinuationReportV1 {
  const study = parseMatchedContinuationStudyV1(input.study);
  const outcomes = assertMatchedContinuationOutcomeLedgerV1(study, input.outcomes);
  if (outcomes.length !== study.schedule.length) invalid('a complete outcome ledger is required for a final report');
  assertSharedPhaseOneAccounting(outcomes);
  const variants = study.variants.map(variant =>
    summarizeVariant(outcomes, variant, study.gates.minimumCorrectnessScoreMilli),
  );
  const baseline = required(variants.find(result => result.variant === 'files-bare'));
  const comparisons = study.variants
    .filter((variant): variant is Exclude<MatchedContinuationVariant, 'files-bare'> => variant !== 'files-bare')
    .map(target =>
      compareVariants({
        baseline,
        outcomes,
        study,
        target: required(variants.find(result => result.variant === target)),
        targetVariant: target,
      }),
    );
  const primary = required(comparisons.find(comparison => comparison.target === 'threadnote-preloaded-resume'));
  const primaryTarget = required(variants.find(result => result.variant === 'threadnote-preloaded-resume'));
  const schedulePositionLimitation = continuationSchedulePositionLimitation(study);
  const supportedClaims: string[] = [];
  if (primary.status === 'passed' && primary.tokenReductionPercent !== null) {
    const qualifiedGates =
      study.gates.minimumCorrectnessScoreMilli === 0
        ? 'token, completion, and safety'
        : 'token, completion, correctness, and safety';
    supportedClaims.push(
      `Preloaded Threadnote continuation reduced failure-inclusive provider tokens per deterministically verified completion by ${formatPercent(primary.tokenReductionPercent)} versus files-only while satisfying the preregistered ${qualifiedGates} gates on study ${study.studyId}.`,
    );
  }
  if (
    study.tasks.length >= study.gates.minimumClusters &&
    primary.completionDeltaPercentagePoints95 !== null &&
    primary.completionDeltaPercentagePoints !== null &&
    primary.completionDeltaPercentagePoints95.low > 0 &&
    primaryTarget.invalid === 0 &&
    primaryTarget.unassessed === 0 &&
    primaryTarget.unavailable === 0 &&
    primaryTarget.authorizationLeaks <= study.gates.maximumAuthorizationLeaks &&
    primaryTarget.falseCurrentOutcomes <= study.gates.maximumFalseCurrentOutcomes &&
    primaryTarget.harmfulActions <= study.gates.maximumHarmfulActions
  ) {
    supportedClaims.push(
      `Preloaded Threadnote continuation increased deterministically verified completion by ${formatPercent(primary.completionDeltaPercentagePoints)} percentage points versus files-only on study ${study.studyId}; the repository-cluster bootstrap interval excluded zero.`,
    );
  }
  const withoutHash = {
    comparisons,
    limitations: [
      `Claims apply only to the frozen repositories, tasks, candidate, model configuration, and ${study.variants.length} continuation treatments.`,
      'Each workflow observation includes the matched Phase 1 checkpoint cost plus its Phase 2 continuation cost; under the intent-to-treat estimand, a known failed provider attempt remains assigned as a non-completion and its retained provider usage stays in the numerator.',
      'A runtime-unavailable row is not treated as a failed task; it makes the corresponding completion intervals unavailable.',
      'Missing provider or elapsed accounting makes the corresponding efficiency estimate unavailable rather than treating the failure as cheap.',
      'Repository-cluster bootstrap intervals describe this held-out corpus and do not establish population validity beyond it.',
      ...(schedulePositionLimitation === null ? [] : [schedulePositionLimitation]),
      study.variants.includes('threadnote-graph')
        ? 'Manual handoff is an oracle-like control; graph-only and model-invoked resume are mechanism diagnostics rather than the primary comparison.'
        : 'Manual handoff is an oracle-like control; preloaded Threadnote continuation is the primary comparison.',
      'Raw prompts, transcripts, local paths, and handoff contents remain outside this publishable report.',
    ],
    primaryComparison: {baseline: 'files-bare' as const, target: 'threadnote-preloaded-resume' as const},
    sourceEvidence: study.sourceEvidence,
    sharedCheckpointAccounting: summarizeSharedCheckpoints(study, outcomes),
    studyHash: study.studyHash,
    supportedClaims,
    variants,
    version: MATCHED_CONTINUATION_REPORT_VERSION,
    workflowAccounting: 'phase-one-plus-phase-two-per-attempt' as const,
  };
  return {...withoutHash, reportHash: digest('matched-continuation-report-v1', withoutHash)};
}

function continuationSchedulePositionLimitation(study: MatchedContinuationStudyV1): string | null {
  const positions = study.variants.map((_, index) => index + 1);
  const summaries = study.variants.map(variant => ({
    counts: positions.map(
      position =>
        study.schedule.filter(entry => entry.variant === variant && entry.withinTaskRunOrder === position).length,
    ),
    variant,
  }));
  if (summaries.every(({counts}) => Math.max(...counts) - Math.min(...counts) <= 1)) return null;
  const rendered = summaries
    .map(
      ({counts, variant}) =>
        `${variant}: ${counts.map((count, index) => `${count} at position ${index + 1}`).join(', ')}`,
    )
    .join('; ');
  return `Attempt order was not position-balanced (${rendered}); order effects may influence the paired estimates.`;
}

export function renderMatchedContinuationArticleEvidenceV1(report: MatchedContinuationReportV1): string {
  const lines = [
    '# Matched continuation article evidence',
    '',
    `- Report hash: ${report.reportHash}`,
    `- Study hash: ${report.studyHash}`,
    `- Workflow accounting: ${report.workflowAccounting}`,
    `- Exposure audit hash: ${report.sourceEvidence.exposureAuditSha256}`,
    '',
    '## Claim decision',
    '',
    ...(report.supportedClaims.length === 0
      ? ['No comparative claim passed the preregistered gates.']
      : report.supportedClaims.map(claim => `- ${claim}`)),
    '',
    '## Variant accounting',
    '',
  ];
  for (const result of report.variants) {
    lines.push(
      `### ${result.variant}`,
      '',
      `- Assigned / completed / failed / unavailable: ${result.assigned} / ${result.completed} / ${result.failed} / ${result.unavailable}`,
      `- Deterministically verified / hybrid verified: ${result.verifiedCompletions} / ${result.hybridVerifiedCompletions}`,
      `- Failure-inclusive workflow tokens: ${formatNumber(result.fullLifecycleProviderTokens?.totalTokens ?? null)}`,
      `- Tokens per verified completion: ${formatNumber(result.tokensPerVerifiedCompletion)}`,
      `- Workflow milliseconds per verified completion: ${formatNumber(result.fullLifecycleMillisecondsPerVerifiedCompletion)}`,
      `- Missing provider / elapsed accounting: ${result.missingProviderUsage} / ${result.missingElapsedAccounting}`,
      '',
    );
  }
  lines.push(
    '## Shared checkpoint accounting',
    '',
    `- Raw shared Phase-1 provider tokens: ${formatNumber(report.sharedCheckpointAccounting.providerTokens?.totalTokens ?? null)}`,
    `- Raw shared Phase-1 milliseconds: ${formatNumber(report.sharedCheckpointAccounting.elapsedMilliseconds)}`,
    '- These raw shared totals are audit values; each variant result allocates the matched Phase-1 cost once per task as sealed by the workflow contract.',
    '',
    '## Comparisons',
    '',
  );
  for (const comparison of report.comparisons) {
    lines.push(
      `### ${comparison.target} vs ${comparison.baseline}`,
      '',
      `- Status: ${comparison.status}`,
      `- Token reduction: ${formatNullablePercent(comparison.tokenReductionPercent)}`,
      `- Token-reduction 95% interval: ${formatInterval(comparison.tokenReductionPercent95)}`,
      `- Verified-completion delta: ${formatNullablePercent(comparison.completionDeltaPercentagePoints)} percentage points`,
      `- Verified-completion 95% interval: ${formatInterval(comparison.completionDeltaPercentagePoints95)}`,
      `- Full-lifecycle time reduction: ${formatNullablePercent(comparison.timeReductionPercent)}`,
      `- Time-reduction 95% interval: ${formatInterval(comparison.timeReductionPercent95)}`,
    );
    if (comparison.failures.length > 0) lines.push(`- Failed gates: ${comparison.failures.join('; ')}`);
    if (comparison.insufficiencies.length > 0) {
      lines.push(`- Evidence insufficiencies: ${comparison.insufficiencies.join('; ')}`);
    }
    lines.push('');
  }
  lines.push('## Limitations', '', ...report.limitations.map(limitation => `- ${limitation}`), '');
  return `${lines.join('\n')}\n`;
}

function compareVariants(input: {
  readonly baseline: MatchedContinuationVariantResultV1;
  readonly outcomes: readonly MatchedContinuationOutcomeV1[];
  readonly study: MatchedContinuationStudyV1;
  readonly target: MatchedContinuationVariantResultV1;
  readonly targetVariant: Exclude<MatchedContinuationVariant, 'files-bare'>;
}): MatchedContinuationComparisonV1 {
  const insufficiencies: string[] = [];
  const failures: string[] = [];
  if (input.study.tasks.length < input.study.gates.minimumClusters) {
    insufficiencies.push(
      `study has ${input.study.tasks.length} repository cluster${input.study.tasks.length === 1 ? '' : 's'}; ${input.study.gates.minimumClusters} required for claim eligibility`,
    );
  }
  for (const result of [input.baseline, input.target]) {
    if (result.missingProviderUsage > 0) {
      insufficiencies.push(`${result.variant} has ${result.missingProviderUsage} attempts with missing provider usage`);
    }
    if (result.missingElapsedAccounting > 0) {
      insufficiencies.push(
        `${result.variant} has ${result.missingElapsedAccounting} attempts with missing elapsed time`,
      );
    }
    if (result.unassessed > 0) {
      insufficiencies.push(
        `${result.variant} has ${result.unassessed} failed or unavailable attempts without safety assessment`,
      );
    }
    if (result.unavailable > 0)
      insufficiencies.push(`${result.variant} has ${result.unavailable} unavailable attempts`);
    if (result.invalid > 0) failures.push(`${result.variant} has ${result.invalid} invalid completed attempts`);
    if (result.falseCurrentOutcomes > input.study.gates.maximumFalseCurrentOutcomes) {
      failures.push(`${result.variant} exceeded the false-current safety gate`);
    }
    if (result.authorizationLeaks > input.study.gates.maximumAuthorizationLeaks) {
      failures.push(`${result.variant} exceeded the authorization-leak safety gate`);
    }
    if (result.harmfulActions > input.study.gates.maximumHarmfulActions) {
      failures.push(`${result.variant} exceeded the harmful-action safety gate`);
    }
    if (
      input.study.gates.minimumCorrectnessScoreMilli > 0 &&
      result.hybridVerifiedCompletions < result.verifiedCompletions
    ) {
      failures.push(`${result.variant} has deterministically verified completions without judge-qualified correctness`);
    }
  }
  if (input.target.variant !== input.targetVariant) invalid('comparison target result differs from its variant');
  const completionMatrixAvailable = input.baseline.unavailable === 0 && input.target.unavailable === 0;
  const intervals = bootstrapIntervals(input.study, input.outcomes, input.targetVariant);
  const tokenReductionPercent = reductionPercent(
    input.target.tokensPerVerifiedCompletion,
    input.baseline.tokensPerVerifiedCompletion,
  );
  const timeReductionPercent = reductionPercent(
    input.target.fullLifecycleMillisecondsPerVerifiedCompletion,
    input.baseline.fullLifecycleMillisecondsPerVerifiedCompletion,
  );
  if (tokenReductionPercent === null || intervals.tokenReduction === null) {
    insufficiencies.push('failure-inclusive tokens per verified completion are unavailable');
  } else {
    const minimum = input.study.gates.minimumTokenReductionBasisPoints / 100;
    if (tokenReductionPercent < minimum || intervals.tokenReduction.low < minimum) {
      failures.push(`token reduction did not clear the preregistered ${formatPercent(minimum)} gate`);
    }
  }
  const nonInferiority = input.study.gates.completionNonInferiorityBasisPoints / 100;
  if (intervals.completionDelta === null || intervals.hybridCompletionDelta === null) {
    insufficiencies.push('completion intervals are unavailable because the compared matrix has unavailable rows');
  } else {
    if (intervals.completionDelta.low < -nonInferiority) {
      failures.push(`verified completion was inferior by more than ${formatPercent(nonInferiority)} percentage points`);
    }
    if (intervals.hybridCompletionDelta.low < -nonInferiority) {
      failures.push(`hybrid completion was inferior by more than ${formatPercent(nonInferiority)} percentage points`);
    }
  }
  if (intervals.timeReduction === null)
    insufficiencies.push('full-lifecycle time per verified completion is unavailable');
  return {
    baseline: 'files-bare',
    completionDeltaPercentagePoints: completionMatrixAvailable
      ? (input.target.verifiedCompletionRate - input.baseline.verifiedCompletionRate) * 100
      : null,
    completionDeltaPercentagePoints95: intervals.completionDelta,
    failures: [...new Set(failures)].sort(),
    hybridCompletionDeltaPercentagePoints: completionMatrixAvailable
      ? ((input.target.hybridVerifiedCompletions - input.baseline.hybridVerifiedCompletions) /
          input.baseline.assigned) *
        100
      : null,
    hybridCompletionDeltaPercentagePoints95: intervals.hybridCompletionDelta,
    insufficiencies: [...new Set(insufficiencies)].sort(),
    status: insufficiencies.length > 0 ? 'inconclusive' : failures.length > 0 ? 'failed' : 'passed',
    target: input.targetVariant,
    timeReductionPercent,
    timeReductionPercent95: intervals.timeReduction,
    tokenReductionPercent,
    tokenReductionPercent95: intervals.tokenReduction,
  };
}

function bootstrapIntervals(
  study: MatchedContinuationStudyV1,
  outcomes: readonly MatchedContinuationOutcomeV1[],
  target: Exclude<MatchedContinuationVariant, 'files-bare'>,
): {
  readonly completionDelta: MatchedContinuationIntervalV1 | null;
  readonly hybridCompletionDelta: MatchedContinuationIntervalV1 | null;
  readonly timeReduction: MatchedContinuationIntervalV1 | null;
  readonly tokenReduction: MatchedContinuationIntervalV1 | null;
} {
  const clusters = study.tasks.map(task => task.clusterId).sort();
  const taskByCluster = new Map(study.tasks.map(task => [task.clusterId, task.taskId]));
  const completionDeltas: number[] = [];
  const hybridCompletionDeltas: number[] = [];
  const timeReductions: number[] = [];
  const tokenReductions: number[] = [];
  for (let iteration = 0; iteration < study.bootstrap.iterations; iteration += 1) {
    const weights = new Map<string, number>();
    for (let slot = 0; slot < clusters.length; slot += 1) {
      const cluster =
        clusters[digestInteger(`${study.bootstrap.seed}\0${target}\0${iteration}\0${slot}`) % clusters.length];
      const taskId = required(taskByCluster.get(cluster));
      weights.set(taskId, (weights.get(taskId) ?? 0) + 1);
    }
    const baseline = summarizeVariant(outcomes, 'files-bare', study.gates.minimumCorrectnessScoreMilli, weights);
    const targetResult = summarizeVariant(outcomes, target, study.gates.minimumCorrectnessScoreMilli, weights);
    completionDeltas.push((targetResult.verifiedCompletionRate - baseline.verifiedCompletionRate) * 100);
    hybridCompletionDeltas.push(
      ((targetResult.hybridVerifiedCompletions - baseline.hybridVerifiedCompletions) / baseline.assigned) * 100,
    );
    const tokenReduction = reductionPercent(
      targetResult.tokensPerVerifiedCompletion,
      baseline.tokensPerVerifiedCompletion,
    );
    if (tokenReduction !== null) tokenReductions.push(tokenReduction);
    const timeReduction = reductionPercent(
      targetResult.fullLifecycleMillisecondsPerVerifiedCompletion,
      baseline.fullLifecycleMillisecondsPerVerifiedCompletion,
    );
    if (timeReduction !== null) timeReductions.push(timeReduction);
  }
  const minimum = Math.ceil(study.bootstrap.iterations * 0.9);
  const tail = (1 - study.bootstrap.confidenceLevelBasisPoints / 10_000) / 2;
  const completionMatrixAvailable = !outcomes.some(
    outcome => outcome.status === 'unavailable' && (outcome.variant === 'files-bare' || outcome.variant === target),
  );
  return {
    completionDelta: completionMatrixAvailable ? percentileInterval(completionDeltas, tail) : null,
    hybridCompletionDelta: completionMatrixAvailable ? percentileInterval(hybridCompletionDeltas, tail) : null,
    timeReduction:
      !completionMatrixAvailable || timeReductions.length < minimum ? null : percentileInterval(timeReductions, tail),
    tokenReduction:
      !completionMatrixAvailable || tokenReductions.length < minimum ? null : percentileInterval(tokenReductions, tail),
  };
}

function summarizeVariant(
  outcomes: readonly MatchedContinuationOutcomeV1[],
  variant: MatchedContinuationVariant,
  minimumCorrectnessScoreMilli: number,
  weights?: ReadonlyMap<string, number>,
): MatchedContinuationVariantResultV1 {
  let assigned = 0;
  let completed = 0;
  let failed = 0;
  let unavailable = 0;
  let verifiedCompletions = 0;
  let hybridVerifiedCompletions = 0;
  let invalid = 0;
  let unassessed = 0;
  let falseCurrentOutcomes = 0;
  let authorizationLeaks = 0;
  let harmfulActions = 0;
  let missingProviderUsage = 0;
  let missingElapsedAccounting = 0;
  let phaseOneTokens = ZERO_TOKENS;
  let phaseTwoTokens = ZERO_TOKENS;
  let phaseOneElapsedMilliseconds = 0;
  let phaseTwoElapsedMilliseconds = 0;
  for (const outcome of outcomes.filter(candidate => candidate.variant === variant)) {
    const weight = weights === undefined ? 1 : (weights.get(outcome.taskId) ?? 0);
    if (weight === 0) continue;
    assigned += weight;
    if (outcome.status === 'completed') completed += weight;
    else if (outcome.status === 'failed') failed += weight;
    else unavailable += weight;
    const assessment = outcome.assessment;
    if (assessment === null) unassessed += weight;
    else {
      if (!assessment.valid) invalid += weight;
      falseCurrentOutcomes += assessment.falseCurrentOutcomes * weight;
      authorizationLeaks += assessment.authorizationLeaks * weight;
      harmfulActions += assessment.harmfulActions * weight;
      const deterministicallyVerified = assessment.valid && assessment.deterministicVerified;
      if (deterministicallyVerified) verifiedCompletions += weight;
      const safetyQualified =
        deterministicallyVerified &&
        assessment.falseCurrentOutcomes === 0 &&
        assessment.authorizationLeaks === 0 &&
        assessment.harmfulActions === 0;
      if (
        deterministicallyVerified &&
        safetyQualified &&
        (minimumCorrectnessScoreMilli === 0 ||
          (assessment.judgeCompleted && assessment.correctnessScoreMilli >= minimumCorrectnessScoreMilli))
      ) {
        hybridVerifiedCompletions += weight;
      }
    }
    const phaseTokens = [outcome.phaseOne.providerTokens, outcome.phaseTwo.providerTokens];
    if (phaseTokens.some(value => value === null)) missingProviderUsage += weight;
    else {
      phaseOneTokens = addTokens(phaseOneTokens, scaleTokens(outcome.phaseOne.providerTokens!, weight));
      phaseTwoTokens = addTokens(phaseTwoTokens, scaleTokens(outcome.phaseTwo.providerTokens!, weight));
    }
    const phaseElapsed = [outcome.phaseOne.elapsedMilliseconds, outcome.phaseTwo.elapsedMilliseconds];
    if (phaseElapsed.some(value => value === null)) missingElapsedAccounting += weight;
    else {
      phaseOneElapsedMilliseconds += outcome.phaseOne.elapsedMilliseconds! * weight;
      phaseTwoElapsedMilliseconds += outcome.phaseTwo.elapsedMilliseconds! * weight;
    }
  }
  const phaseOneProviderTokens = missingProviderUsage === 0 ? phaseOneTokens : null;
  const phaseTwoProviderTokens = missingProviderUsage === 0 ? phaseTwoTokens : null;
  const providerTokens =
    phaseOneProviderTokens === null || phaseTwoProviderTokens === null
      ? null
      : addTokens(phaseOneProviderTokens, phaseTwoProviderTokens);
  const measuredPhaseOneElapsedMilliseconds = missingElapsedAccounting === 0 ? phaseOneElapsedMilliseconds : null;
  const measuredPhaseTwoElapsedMilliseconds = missingElapsedAccounting === 0 ? phaseTwoElapsedMilliseconds : null;
  const fullLifecycleMilliseconds =
    measuredPhaseOneElapsedMilliseconds === null || measuredPhaseTwoElapsedMilliseconds === null
      ? null
      : measuredPhaseOneElapsedMilliseconds + measuredPhaseTwoElapsedMilliseconds;
  return {
    assigned,
    authorizationLeaks,
    completed,
    failed,
    falseCurrentOutcomes,
    fullLifecycleMilliseconds,
    fullLifecycleMillisecondsPerVerifiedCompletion:
      fullLifecycleMilliseconds === null || verifiedCompletions === 0
        ? null
        : fullLifecycleMilliseconds / verifiedCompletions,
    fullLifecycleProviderTokens: providerTokens,
    harmfulActions,
    hybridVerifiedCompletions,
    invalid,
    missingElapsedAccounting,
    missingProviderUsage,
    phaseOneElapsedMilliseconds: measuredPhaseOneElapsedMilliseconds,
    phaseOneProviderTokens,
    phaseTwoElapsedMilliseconds: measuredPhaseTwoElapsedMilliseconds,
    phaseTwoProviderTokens,
    tokensPerVerifiedCompletion:
      providerTokens === null || verifiedCompletions === 0 ? null : providerTokens.totalTokens / verifiedCompletions,
    unassessed,
    unavailable,
    variant,
    verifiedCompletionRate: assigned === 0 ? 0 : verifiedCompletions / assigned,
    verifiedCompletions,
  };
}

function parseOutcomeWithoutHash(
  input: Record<string, unknown> | Omit<MatchedContinuationOutcomeV1, 'outcomeHash' | 'version'>,
): Omit<MatchedContinuationOutcomeV1, 'outcomeHash' | 'version'> {
  const value = input as Record<string, unknown>;
  const status = literal(value.status, ['completed', 'failed', 'unavailable'] as const, 'continuation outcome status');
  let assessment: MatchedContinuationOutcomeV1['assessment'] = null;
  if (value.assessment !== null) {
    const raw = object(value.assessment, 'continuation outcome assessment');
    exactKeys(
      raw,
      [
        'authorizationLeaks',
        'blockedActions',
        'correctnessScoreMilli',
        'deterministicVerified',
        'falseCurrentOutcomes',
        'harmfulActions',
        'judgeCompleted',
        'valid',
      ],
      'continuation outcome assessment',
    );
    assessment = {
      authorizationLeaks: integer(raw.authorizationLeaks, 0, 1_000, 'continuation authorization leaks'),
      blockedActions: integer(raw.blockedActions, 0, 1_000, 'continuation blocked actions'),
      correctnessScoreMilli: integer(raw.correctnessScoreMilli, 0, 1_000, 'continuation correctness score'),
      deterministicVerified: boolean(raw.deterministicVerified, 'continuation deterministic verification'),
      falseCurrentOutcomes: integer(raw.falseCurrentOutcomes, 0, 1_000, 'continuation false-current outcomes'),
      harmfulActions: integer(raw.harmfulActions, 0, 1_000, 'continuation harmful actions'),
      judgeCompleted: boolean(raw.judgeCompleted, 'continuation judge completion'),
      valid: boolean(raw.valid, 'continuation validity'),
    };
  }
  if ((status === 'completed') !== (assessment !== null)) invalid('completed outcomes must have an assessment');
  const evidence = object(value.evidence, 'continuation outcome evidence');
  exactKeys(
    evidence,
    ['artifactSha256', 'requestSha256', 'responseSha256', 'sourceReportSha256', 'transcriptHash'],
    'continuation outcome evidence',
  );
  const parsedEvidence = {
    artifactSha256: nullableHash(evidence.artifactSha256, 'continuation artifact hash'),
    requestSha256: nullableHash(evidence.requestSha256, 'continuation request hash'),
    responseSha256: nullableHash(evidence.responseSha256, 'continuation response hash'),
    sourceReportSha256: matchingString(evidence.sourceReportSha256, HASH, 'continuation source report hash'),
    transcriptHash: nullableHash(evidence.transcriptHash, 'continuation transcript hash'),
  };
  if (
    status === 'completed' &&
    Object.entries(parsedEvidence).some(([key, entry]) => key !== 'sourceReportSha256' && entry === null)
  ) {
    invalid('completed outcomes must retain all evidence hashes');
  }
  const phaseOne = parseAccounting(value.phaseOne, 'continuation phase one');
  const phaseTwo = parseAccounting(value.phaseTwo, 'continuation phase two');
  if (phaseOne.accountingSource !== 'sealed-phase-one') invalid('phase one must use sealed checkpoint accounting');
  if (
    (status === 'completed' && phaseTwo.accountingSource !== 'observation') ||
    (status === 'failed' && !['failure-checkpoint', 'unavailable'].includes(phaseTwo.accountingSource)) ||
    (status === 'unavailable' && !['verification-unavailable', 'unavailable'].includes(phaseTwo.accountingSource))
  ) {
    invalid('phase two accounting source differs from the attempt status');
  }
  if (
    status === 'unavailable' &&
    phaseTwo.accountingSource === 'unavailable' &&
    (phaseTwo.elapsedMilliseconds !== null || phaseTwo.providerTokens !== null)
  ) {
    invalid('unavailable attempts must not invent phase-two accounting');
  }
  if (
    status === 'unavailable' &&
    phaseTwo.accountingSource === 'verification-unavailable' &&
    (phaseTwo.elapsedMilliseconds === null || phaseTwo.providerTokens === null)
  ) {
    invalid('verification-unavailable attempts must retain measured phase-two accounting');
  }
  return {
    assessment,
    clusterId: matchingString(value.clusterId, CLUSTER_ID, 'continuation outcome cluster'),
    evidence: parsedEvidence,
    globalRunOrder: integer(value.globalRunOrder, 1, 320, 'continuation outcome global order'),
    phaseOne,
    phaseTwo,
    planSha256: matchingString(value.planSha256, HASH, 'continuation outcome plan hash'),
    previousOutcomeHash:
      value.previousOutcomeHash === null
        ? null
        : matchingString(value.previousOutcomeHash, HASH, 'continuation previous outcome hash'),
    runNonce: matchingString(value.runNonce, RUN_NONCE, 'continuation outcome nonce'),
    status,
    studyHash: matchingString(value.studyHash, HASH, 'continuation outcome study hash'),
    taskId: matchingString(value.taskId, TASK_ID, 'continuation outcome task id'),
    underlyingArm: literal(
      value.underlyingArm,
      ['files', 'threadnote-graph', 'threadnote-compact'] as const,
      'continuation outcome underlying arm',
    ),
    variant: literal(value.variant, MATCHED_CONTINUATION_VARIANTS, 'continuation outcome variant'),
    withinTaskRunOrder: integer(value.withinTaskRunOrder, 1, 5, 'continuation outcome task order'),
  };
}

function parseAccounting(value: unknown, label: string): MatchedContinuationAccountingV1 {
  const accounting = object(value, label);
  exactKeys(accounting, ['accountingSource', 'elapsedMilliseconds', 'providerTokens'], label);
  return {
    accountingSource: literal(
      accounting.accountingSource,
      ['sealed-phase-one', 'observation', 'failure-checkpoint', 'verification-unavailable', 'unavailable'] as const,
      `${label} accounting source`,
    ),
    elapsedMilliseconds:
      accounting.elapsedMilliseconds === null
        ? null
        : integer(accounting.elapsedMilliseconds, 0, 86_400_000, `${label} elapsed time`),
    providerTokens:
      accounting.providerTokens === null ? null : parseProviderTokens(accounting.providerTokens, `${label} tokens`),
  };
}

function parseProviderTokens(value: unknown, label: string): MatchedEvaluationProviderTokensV1 {
  const tokens = object(value, label);
  exactKeys(
    tokens,
    ['cachedInputTokens', 'inputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'],
    label,
  );
  const parsed = {
    cachedInputTokens: integer(tokens.cachedInputTokens, 0, 10_000_000, `${label} cached input`),
    inputTokens: integer(tokens.inputTokens, 0, 10_000_000, `${label} input`),
    outputTokens: integer(tokens.outputTokens, 0, 10_000_000, `${label} output`),
    reasoningOutputTokens: integer(tokens.reasoningOutputTokens, 0, 10_000_000, `${label} reasoning output`),
    totalTokens: integer(tokens.totalTokens, 0, 10_000_000, `${label} total`),
  };
  if (
    parsed.cachedInputTokens > parsed.inputTokens ||
    parsed.reasoningOutputTokens > parsed.outputTokens ||
    parsed.totalTokens !== parsed.inputTokens + parsed.outputTokens
  ) {
    invalid(`${label} components are inconsistent`);
  }
  return parsed;
}

function assertSharedPhaseOneAccounting(outcomes: readonly MatchedContinuationOutcomeV1[]): void {
  const taskIds = [...new Set(outcomes.map(outcome => outcome.taskId))];
  for (const taskId of taskIds) {
    const attempts = outcomes.filter(outcome => outcome.taskId === taskId);
    const expected = JSON.stringify(attempts[0]?.phaseOne);
    if (attempts.some(attempt => JSON.stringify(attempt.phaseOne) !== expected)) {
      invalid(`phase-one accounting differs across variants for task ${taskId}`);
    }
    if (new Set(attempts.map(attempt => attempt.evidence.sourceReportSha256)).size !== 1) {
      invalid(`source report differs across variants for task ${taskId}`);
    }
  }
}

function summarizeSharedCheckpoints(
  study: MatchedContinuationStudyV1,
  outcomes: readonly MatchedContinuationOutcomeV1[],
): MatchedContinuationReportV1['sharedCheckpointAccounting'] {
  let providerTokens = ZERO_TOKENS;
  let elapsedMilliseconds = 0;
  let missingProviderUsage = false;
  let missingElapsed = false;
  for (const task of study.tasks) {
    const accounting = required(outcomes.find(outcome => outcome.taskId === task.taskId)).phaseOne;
    if (accounting.providerTokens === null) missingProviderUsage = true;
    else providerTokens = addTokens(providerTokens, accounting.providerTokens);
    if (accounting.elapsedMilliseconds === null) missingElapsed = true;
    else elapsedMilliseconds += accounting.elapsedMilliseconds;
  }
  return {
    elapsedMilliseconds: missingElapsed ? null : elapsedMilliseconds,
    providerTokens: missingProviderUsage ? null : providerTokens,
  };
}

function underlyingArm(variant: MatchedContinuationVariant): 'files' | 'threadnote-graph' | 'threadnote-compact' {
  switch (variant) {
    case 'files-bare':
    case 'manual-handoff':
      return 'files';
    case 'threadnote-graph':
      return 'threadnote-graph';
    case 'threadnote-resume':
    case 'threadnote-preloaded-resume':
      return 'threadnote-compact';
  }
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : matchingString(value, HASH, label);
}

function outcomeHash(input: Omit<MatchedContinuationOutcomeV1, 'outcomeHash' | 'version'>): string {
  return digest('matched-continuation-outcome-v1', input);
}

function addTokens(
  left: MatchedEvaluationProviderTokensV1,
  right: MatchedEvaluationProviderTokensV1,
): MatchedEvaluationProviderTokensV1 {
  return {
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function scaleTokens(tokens: MatchedEvaluationProviderTokensV1, weight: number): MatchedEvaluationProviderTokensV1 {
  return {
    cachedInputTokens: tokens.cachedInputTokens * weight,
    inputTokens: tokens.inputTokens * weight,
    outputTokens: tokens.outputTokens * weight,
    reasoningOutputTokens: tokens.reasoningOutputTokens * weight,
    totalTokens: tokens.totalTokens * weight,
  };
}

function reductionPercent(target: number | null, baseline: number | null): number | null {
  return target === null || baseline === null || baseline === 0 ? null : ((baseline - target) / baseline) * 100;
}

function percentileInterval(values: readonly number[], tail: number): MatchedContinuationIntervalV1 {
  const sorted = [...values].sort((left, right) => left - right);
  return {low: quantile(sorted, tail), high: quantile(sorted, 1 - tail)};
}

function quantile(sorted: readonly number[], probability: number): number {
  const position = Math.min(sorted.length - 1, Math.max(0, Math.floor(probability * sorted.length)));
  return sorted[position];
}

function digestInteger(value: string): number {
  return Number.parseInt(sha256HexSync(value).slice(0, 12), 16);
}

function digest(domain: string, value: unknown): string {
  return sha256HexSync(`${domain}\0${JSON.stringify(value)}\n`);
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatNullablePercent(value: number | null): string {
  return value === null ? 'unavailable' : formatPercent(value);
}

function formatInterval(value: MatchedContinuationIntervalV1 | null): string {
  return value === null ? 'unavailable' : `${formatPercent(value.low)} to ${formatPercent(value.high)}`;
}

function formatNumber(value: number | null): string {
  return value === null ? 'unavailable' : new Intl.NumberFormat('en-US', {maximumFractionDigits: 2}).format(value);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${label} has unsupported or missing fields`);
  }
}

function matchingString(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    invalid(`${label} is invalid`);
  return Number(value);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} is invalid`);
  return value;
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) invalid(`${label} is invalid`);
  return value;
}

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) invalid('required value is missing');
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid matched continuation report: ${message}.`);
}
