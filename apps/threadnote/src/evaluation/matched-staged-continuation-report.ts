import {sha256HexSync} from '@threadnote/platform/sha256';

export const MATCHED_STAGED_CONTINUATION_REPORT_VERSION = 1 as const;
export const MATCHED_STAGED_CONTINUATION_VARIANTS = ['files-bare', 'threadnote-preloaded-resume'] as const;

export type MatchedStagedContinuationVariant = (typeof MATCHED_STAGED_CONTINUATION_VARIANTS)[number];

export interface MatchedStagedContinuationRowV1 {
  readonly clusterId: string;
  readonly taskId: string;
  readonly variant: MatchedStagedContinuationVariant;
  readonly runNonce: string;
  readonly failureStage: 'none' | 'common-phase-one';
  readonly phaseTwoAttempted: boolean;
  readonly deterministicVerified: boolean;
  readonly hybridVerified: boolean;
  readonly valid: boolean;
  readonly falseCurrentOutcomes: number;
  readonly authorizationLeaks: number;
  readonly harmfulActions: number;
  readonly phaseOneTokens: number;
  readonly phaseTwoTokens: number;
  readonly phaseOneMilliseconds: number;
  readonly phaseTwoMilliseconds: number;
  readonly modelCalls: number;
  readonly toolTurns: number;
  readonly redundantFileReads: number;
  readonly mcpToolCallBytes: number;
  readonly initialContinuationEvidenceState: 'evidence-bearing' | null;
  readonly exactAuthoredGraphQueryFirst: boolean | null;
}

export interface MatchedStagedContinuationReportInputV1 {
  readonly bootstrap: {
    readonly confidenceLevelBasisPoints: 9500;
    readonly iterations: number;
    readonly seed: string;
  };
  readonly gates: {
    readonly completionNonInferiorityBasisPoints: number;
    readonly maximumAuthorizationLeaks: number;
    readonly maximumFalseCurrentOutcomes: number;
    readonly maximumHarmfulActions: number;
    readonly minimumClusters: number;
    readonly minimumTokenReductionBasisPoints: number;
  };
  readonly rows: readonly MatchedStagedContinuationRowV1[];
}

export interface MatchedStagedContinuationVariantResultV1 {
  readonly assigned: number;
  readonly verifiedCompletions: number;
  readonly hybridVerifiedCompletions: number;
  readonly verifiedCompletionRate: number;
  readonly phaseOneTokens: number;
  readonly phaseTwoTokens: number;
  readonly lifecycleTokens: number;
  readonly tokensPerVerifiedCompletion: number | null;
  readonly phaseOneMilliseconds: number;
  readonly phaseTwoMilliseconds: number;
  readonly lifecycleMilliseconds: number;
  readonly millisecondsPerVerifiedCompletion: number | null;
  readonly modelCalls: number;
  readonly toolTurns: number;
  readonly redundantFileReads: number;
  readonly mcpToolCallBytes: number;
  readonly invalid: number;
  readonly falseCurrentOutcomes: number;
  readonly authorizationLeaks: number;
  readonly harmfulActions: number;
}

export interface MatchedStagedContinuationIntervalV1 {
  readonly low: number;
  readonly high: number;
}

export interface MatchedStagedContinuationReportV1 {
  readonly version: typeof MATCHED_STAGED_CONTINUATION_REPORT_VERSION;
  readonly reportHash: string;
  readonly clusters: number;
  readonly commonPhaseFailures: number;
  readonly filesBare: MatchedStagedContinuationVariantResultV1;
  readonly threadnotePreloadedResume: MatchedStagedContinuationVariantResultV1;
  readonly completionDeltaPercentagePoints: number;
  readonly completionDeltaPercentagePoints95: MatchedStagedContinuationIntervalV1;
  readonly hybridCompletionDeltaPercentagePoints: number;
  readonly hybridCompletionDeltaPercentagePoints95: MatchedStagedContinuationIntervalV1;
  readonly lifecycleTokenReductionPercent: number | null;
  readonly lifecycleTokenReductionPercent95: MatchedStagedContinuationIntervalV1 | null;
  readonly lifecycleTimeReductionPercent: number | null;
  readonly lifecycleTimeReductionPercent95: MatchedStagedContinuationIntervalV1 | null;
  readonly validBootstrapSamples: number;
  readonly minimumBootstrapSamples: number;
  readonly numericTokenGatePassed: boolean;
  readonly numericCompletionGatePassed: boolean;
  readonly safetyGatePassed: boolean;
  readonly articleClaimEligible: boolean;
}

const HASH = /^[0-9a-f]{64}$/u;
const CLUSTER_ID = /^cluster_[0-9a-f]{16,64}$/u;
const TASK_ID = /^tsk_[0-9a-f]{16,64}$/u;
const RUN_NONCE = /^run_[0-9a-f]{32}$/u;

export function createMatchedStagedContinuationReportV1(
  input: MatchedStagedContinuationReportInputV1,
): MatchedStagedContinuationReportV1 {
  const rows = validateInput(input);
  const clusters = [...new Set(rows.map(row => row.clusterId))].sort();
  const filesBare = summarize(rows, 'files-bare');
  const threadnotePreloadedResume = summarize(rows, 'threadnote-preloaded-resume');
  const intervals = bootstrap(input, rows, clusters);
  const lifecycleTokenReductionPercent = reductionPercent(
    threadnotePreloadedResume.tokensPerVerifiedCompletion,
    filesBare.tokensPerVerifiedCompletion,
  );
  const lifecycleTimeReductionPercent = reductionPercent(
    threadnotePreloadedResume.millisecondsPerVerifiedCompletion,
    filesBare.millisecondsPerVerifiedCompletion,
  );
  const completionDeltaPercentagePoints =
    (threadnotePreloadedResume.verifiedCompletionRate - filesBare.verifiedCompletionRate) * 100;
  const hybridCompletionDeltaPercentagePoints =
    ((threadnotePreloadedResume.hybridVerifiedCompletions - filesBare.hybridVerifiedCompletions) / filesBare.assigned) *
    100;
  const minimumBootstrapSamples = Math.ceil(input.bootstrap.iterations * 0.9);
  const numericTokenGatePassed =
    lifecycleTokenReductionPercent !== null &&
    intervals.token !== null &&
    lifecycleTokenReductionPercent >= input.gates.minimumTokenReductionBasisPoints / 100 &&
    intervals.token.low >= input.gates.minimumTokenReductionBasisPoints / 100;
  const numericCompletionGatePassed =
    intervals.completion.low >= -input.gates.completionNonInferiorityBasisPoints / 100 &&
    intervals.hybridCompletion.low >= -input.gates.completionNonInferiorityBasisPoints / 100;
  const safetyGatePassed = [filesBare, threadnotePreloadedResume].every(
    result =>
      result.invalid === 0 &&
      result.falseCurrentOutcomes <= input.gates.maximumFalseCurrentOutcomes &&
      result.authorizationLeaks <= input.gates.maximumAuthorizationLeaks &&
      result.harmfulActions <= input.gates.maximumHarmfulActions,
  );
  const reportWithoutHash = {
    version: MATCHED_STAGED_CONTINUATION_REPORT_VERSION,
    clusters: clusters.length,
    commonPhaseFailures: clusters.filter(clusterId =>
      rows.some(row => row.clusterId === clusterId && row.failureStage === 'common-phase-one'),
    ).length,
    filesBare,
    threadnotePreloadedResume,
    completionDeltaPercentagePoints,
    completionDeltaPercentagePoints95: intervals.completion,
    hybridCompletionDeltaPercentagePoints,
    hybridCompletionDeltaPercentagePoints95: intervals.hybridCompletion,
    lifecycleTokenReductionPercent,
    lifecycleTokenReductionPercent95: intervals.token,
    lifecycleTimeReductionPercent,
    lifecycleTimeReductionPercent95: intervals.time,
    validBootstrapSamples: intervals.validSamples,
    minimumBootstrapSamples,
    numericTokenGatePassed,
    numericCompletionGatePassed,
    safetyGatePassed,
    articleClaimEligible:
      clusters.length >= input.gates.minimumClusters &&
      intervals.validSamples >= minimumBootstrapSamples &&
      numericTokenGatePassed &&
      numericCompletionGatePassed &&
      safetyGatePassed,
  };
  return {
    ...reportWithoutHash,
    reportHash: sha256HexSync(`matched-staged-continuation-report-v1\0${JSON.stringify(reportWithoutHash)}\n`),
  };
}

function validateInput(input: MatchedStagedContinuationReportInputV1): readonly MatchedStagedContinuationRowV1[] {
  integer(input.bootstrap.iterations, 200, 100_000, 'bootstrap iterations');
  if (input.bootstrap.confidenceLevelBasisPoints !== 9_500) invalid('bootstrap confidence must be 95%');
  matching(input.bootstrap.seed, HASH, 'bootstrap seed');
  integer(input.gates.minimumClusters, 1, 10_000, 'minimum clusters');
  integer(input.gates.minimumTokenReductionBasisPoints, -10_000, 10_000, 'minimum token reduction');
  integer(input.gates.completionNonInferiorityBasisPoints, 0, 10_000, 'completion non-inferiority');
  const rows = input.rows.map((row, index) => validateRow(row, index));
  if (rows.length < 2 || rows.length % 2 !== 0) invalid('rows must contain complete two-arm clusters');
  unique(
    rows.map(row => row.runNonce),
    'run nonces',
  );
  const clusterIds = [...new Set(rows.map(row => row.clusterId))];
  for (const clusterId of clusterIds) {
    const clusterRows = rows.filter(row => row.clusterId === clusterId);
    if (
      clusterRows.length !== 2 ||
      new Set(clusterRows.map(row => row.variant)).size !== 2 ||
      new Set(clusterRows.map(row => row.taskId)).size !== 1
    ) {
      invalid(`cluster ${clusterId} must contain one row per variant for one task`);
    }
    const failures = clusterRows.filter(row => row.failureStage === 'common-phase-one');
    if (failures.length !== 0 && failures.length !== 2) {
      invalid(`cluster ${clusterId} cannot expose a common failure to only one variant`);
    }
    if (
      failures.length === 2 &&
      (clusterRows[0]?.phaseOneTokens !== clusterRows[1]?.phaseOneTokens ||
        clusterRows[0]?.phaseOneMilliseconds !== clusterRows[1]?.phaseOneMilliseconds)
    ) {
      invalid(`cluster ${clusterId} common phase accounting must be symmetric`);
    }
  }
  const threadnoteRows = rows.filter(row => row.variant === 'threadnote-preloaded-resume');
  if (
    threadnoteRows.some(
      row =>
        row.phaseTwoAttempted &&
        (row.initialContinuationEvidenceState !== 'evidence-bearing' || row.exactAuthoredGraphQueryFirst !== true),
    )
  ) {
    invalid('every attempted Threadnote continuation must preload evidence and issue the authored graph query first');
  }
  return rows;
}

function validateRow(row: MatchedStagedContinuationRowV1, index: number): MatchedStagedContinuationRowV1 {
  matching(row.clusterId, CLUSTER_ID, `row ${index} cluster`);
  matching(row.taskId, TASK_ID, `row ${index} task`);
  matching(row.runNonce, RUN_NONCE, `row ${index} nonce`);
  if (!MATCHED_STAGED_CONTINUATION_VARIANTS.includes(row.variant)) invalid(`row ${index} variant is unsupported`);
  for (const [value, label] of [
    [row.phaseOneTokens, 'phase-one tokens'],
    [row.phaseTwoTokens, 'phase-two tokens'],
    [row.phaseOneMilliseconds, 'phase-one milliseconds'],
    [row.phaseTwoMilliseconds, 'phase-two milliseconds'],
    [row.modelCalls, 'model calls'],
    [row.toolTurns, 'tool turns'],
    [row.redundantFileReads, 'redundant file reads'],
    [row.mcpToolCallBytes, 'MCP bytes'],
    [row.falseCurrentOutcomes, 'false-current outcomes'],
    [row.authorizationLeaks, 'authorization leaks'],
    [row.harmfulActions, 'harmful actions'],
  ] as const) {
    integer(value, 0, Number.MAX_SAFE_INTEGER, `row ${index} ${label}`);
  }
  if (
    row.failureStage === 'common-phase-one' &&
    (row.phaseTwoAttempted ||
      row.phaseTwoTokens !== 0 ||
      row.phaseTwoMilliseconds !== 0 ||
      row.deterministicVerified ||
      row.hybridVerified)
  ) {
    invalid(`row ${index} common failure cannot contain a Phase 2 outcome`);
  }
  if (row.failureStage === 'none' && !row.phaseTwoAttempted) invalid(`row ${index} lacks a failure stage`);
  if (row.hybridVerified && !row.deterministicVerified) invalid(`row ${index} hybrid completion lacks verification`);
  return {...row};
}

function summarize(
  rows: readonly MatchedStagedContinuationRowV1[],
  variant: MatchedStagedContinuationVariant,
): MatchedStagedContinuationVariantResultV1 {
  const selected = rows.filter(row => row.variant === variant);
  const sum = (select: (row: MatchedStagedContinuationRowV1) => number) =>
    selected.reduce((total, row) => total + select(row), 0);
  const verifiedCompletions = selected.filter(row => row.deterministicVerified).length;
  const phaseOneTokens = sum(row => row.phaseOneTokens);
  const phaseTwoTokens = sum(row => row.phaseTwoTokens);
  const lifecycleTokens = phaseOneTokens + phaseTwoTokens;
  const phaseOneMilliseconds = sum(row => row.phaseOneMilliseconds);
  const phaseTwoMilliseconds = sum(row => row.phaseTwoMilliseconds);
  const lifecycleMilliseconds = phaseOneMilliseconds + phaseTwoMilliseconds;
  return {
    assigned: selected.length,
    verifiedCompletions,
    hybridVerifiedCompletions: selected.filter(row => row.hybridVerified).length,
    verifiedCompletionRate: verifiedCompletions / selected.length,
    phaseOneTokens,
    phaseTwoTokens,
    lifecycleTokens,
    tokensPerVerifiedCompletion: verifiedCompletions === 0 ? null : lifecycleTokens / verifiedCompletions,
    phaseOneMilliseconds,
    phaseTwoMilliseconds,
    lifecycleMilliseconds,
    millisecondsPerVerifiedCompletion: verifiedCompletions === 0 ? null : lifecycleMilliseconds / verifiedCompletions,
    modelCalls: sum(row => row.modelCalls),
    toolTurns: sum(row => row.toolTurns),
    redundantFileReads: sum(row => row.redundantFileReads),
    mcpToolCallBytes: sum(row => row.mcpToolCallBytes),
    invalid: selected.filter(row => !row.valid).length,
    falseCurrentOutcomes: sum(row => row.falseCurrentOutcomes),
    authorizationLeaks: sum(row => row.authorizationLeaks),
    harmfulActions: sum(row => row.harmfulActions),
  };
}

function bootstrap(
  input: MatchedStagedContinuationReportInputV1,
  rows: readonly MatchedStagedContinuationRowV1[],
  clusters: readonly string[],
) {
  const byCluster = new Map(clusters.map(clusterId => [clusterId, rows.filter(row => row.clusterId === clusterId)]));
  const token: number[] = [];
  const time: number[] = [];
  const completion: number[] = [];
  const hybridCompletion: number[] = [];
  for (let iteration = 0; iteration < input.bootstrap.iterations; iteration += 1) {
    const sampled: MatchedStagedContinuationRowV1[] = [];
    for (let slot = 0; slot < clusters.length; slot += 1) {
      const clusterId =
        clusters[
          digestInteger(`${input.bootstrap.seed}\0threadnote-preloaded-resume\0${iteration}\0${slot}`) % clusters.length
        ];
      sampled.push(...required(byCluster.get(clusterId)));
    }
    const baseline = summarize(sampled, 'files-bare');
    const target = summarize(sampled, 'threadnote-preloaded-resume');
    completion.push((target.verifiedCompletionRate - baseline.verifiedCompletionRate) * 100);
    hybridCompletion.push(
      ((target.hybridVerifiedCompletions - baseline.hybridVerifiedCompletions) / baseline.assigned) * 100,
    );
    const tokenReduction = reductionPercent(target.tokensPerVerifiedCompletion, baseline.tokensPerVerifiedCompletion);
    const timeReduction = reductionPercent(
      target.millisecondsPerVerifiedCompletion,
      baseline.millisecondsPerVerifiedCompletion,
    );
    if (tokenReduction !== null) token.push(tokenReduction);
    if (timeReduction !== null) time.push(timeReduction);
  }
  const minimum = Math.ceil(input.bootstrap.iterations * 0.9);
  const tail = (1 - input.bootstrap.confidenceLevelBasisPoints / 10_000) / 2;
  return {
    completion: percentileInterval(completion, tail),
    hybridCompletion: percentileInterval(hybridCompletion, tail),
    token: token.length >= minimum ? percentileInterval(token, tail) : null,
    time: time.length >= minimum ? percentileInterval(time, tail) : null,
    validSamples: Math.min(token.length, time.length),
  };
}

function reductionPercent(target: number | null, baseline: number | null): number | null {
  return target === null || baseline === null || baseline === 0 ? null : ((baseline - target) / baseline) * 100;
}

function percentileInterval(values: readonly number[], tail: number): MatchedStagedContinuationIntervalV1 {
  const sorted = [...values].sort((left, right) => left - right);
  return {low: quantile(sorted, tail), high: quantile(sorted, 1 - tail)};
}

function quantile(sorted: readonly number[], probability: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(probability * sorted.length)))];
}

function digestInteger(value: string): number {
  return Number.parseInt(sha256HexSync(value).slice(0, 12), 16);
}

function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${label} is invalid`);
  return value;
}

function matching(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) invalid(`${label} is invalid`);
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid(`${label} must be unique`);
}

function required<T>(value: T | undefined): T {
  if (value === undefined) invalid('required value is absent');
  return value;
}

function invalid(message: string): never {
  throw new Error(`Invalid staged continuation report: ${message}.`);
}
