import {Array as EffectArray} from 'effect';
import type {
  RecallEvaluationCategory,
  RecallEvaluationComparisonV1,
  RecallEvaluationMetricSetV1,
  RecallEvaluationResultV1,
} from './recall.js';
import {compareRecallEvaluationResults, RECALL_EVALUATION_CATEGORIES} from './recall.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const RECALL_NON_INFERIORITY_POLICY_VERSION = 1 as const;

const HIGHER_IS_BETTER = [
  'explanationCoverage',
  'meanNdcgAt10',
  'meanNdcgAt5',
  'meanReciprocalRank',
  'noAnswerF1',
  'noAnswerPrecision',
  'noAnswerRecall',
  'recallAt1',
  'recallAt10',
  'recallAt5',
] as const satisfies readonly (keyof RecallEvaluationMetricSetV1)[];

const LOWER_IS_BETTER = [
  'authorityInversionRate',
  'expansionFallbackRate',
  'forbiddenHitRate',
  'staleHitRate',
] as const satisfies readonly (keyof RecallEvaluationMetricSetV1)[];

export interface RecallNonInferiorityPolicyV1 {
  readonly aggregateQualityMargin: number;
  readonly categoryQualityMargin: number;
  readonly maximumContractFailureIncrease: number;
  readonly maximumSafetyRegression: number;
  readonly version: typeof RECALL_NON_INFERIORITY_POLICY_VERSION;
}

export interface RecallNonInferiorityGateV1 {
  readonly comparison: RecallEvaluationComparisonV1;
  readonly failures: readonly string[];
  readonly passed: boolean;
  readonly policy: RecallNonInferiorityPolicyV1;
  readonly version: 1;
}

export const DEFAULT_RECALL_NON_INFERIORITY_POLICY: RecallNonInferiorityPolicyV1 = {
  aggregateQualityMargin: 0.01,
  categoryQualityMargin: 0.05,
  maximumContractFailureIncrease: 0,
  maximumSafetyRegression: 0,
  version: RECALL_NON_INFERIORITY_POLICY_VERSION,
};

export function evaluateRecallNonInferiority(
  baseline: RecallEvaluationResultV1,
  candidate: RecallEvaluationResultV1,
  policy = DEFAULT_RECALL_NON_INFERIORITY_POLICY,
): RecallNonInferiorityGateV1 {
  validatePolicy(policy);
  const comparison = compareRecallEvaluationResults(baseline, candidate);
  const failures: string[] = [];

  checkMetricDeltas('aggregate', comparison.metrics, policy.aggregateQualityMargin, policy, failures);
  for (const category of RECALL_EVALUATION_CATEGORIES) {
    const delta = comparison.categoryDeltas[category];
    if (delta) checkMetricDeltas(category, delta, policy.categoryQualityMargin, policy, failures);
  }

  const contractFailureIncrease = candidate.failures.length - baseline.failures.length;
  if (contractFailureIncrease > policy.maximumContractFailureIncrease) {
    failures.push(
      `contract failures increased by ${contractFailureIncrease}; maximum ${policy.maximumContractFailureIncrease}`,
    );
  }
  const baselineHasReviewedFailureIdentities = EffectArray.some(
    baseline.failures,
    failure => !Effect.pipe(failure, EffectString.startsWith('known-baseline-defect-')),
  );
  if (baselineHasReviewedFailureIdentities) {
    const reviewedFailures = new Set(baseline.failures);
    const introducedFailures = [
      ...new Set(EffectArray.filter(candidate.failures, failure => !reviewedFailures.has(failure))),
    ];
    if (introducedFailures.length > policy.maximumContractFailureIncrease) {
      failures.push(
        `new contract failure identities: ${EffectArray.join(introducedFailures.slice(0, 5), '; ')}${introducedFailures.length > 5 ? `; … ${introducedFailures.length - 5} more` : ''}`,
      );
    }
  }

  return {
    comparison,
    failures,
    passed: failures.length === 0,
    policy,
    version: 1,
  };
}

function checkMetricDeltas(
  scope: 'aggregate' | RecallEvaluationCategory,
  delta: RecallEvaluationComparisonV1['metrics'],
  qualityMargin: number,
  policy: RecallNonInferiorityPolicyV1,
  failures: string[],
): void {
  for (const metric of HIGHER_IS_BETTER) {
    if (delta[metric] < -qualityMargin) {
      failures.push(`${scope}.${metric} regressed by ${format(delta[metric])}; margin ${format(qualityMargin)}`);
    }
  }
  for (const metric of LOWER_IS_BETTER) {
    if (delta[metric] > policy.maximumSafetyRegression) {
      failures.push(
        `${scope}.${metric} regressed by ${format(delta[metric])}; maximum ${format(policy.maximumSafetyRegression)}`,
      );
    }
  }
}

function validatePolicy(policy: RecallNonInferiorityPolicyV1): void {
  for (const [name, value] of EffectRecord.toEntries(policy)) {
    if (name === 'version') continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Recall non-inferiority policy ${name} must be a non-negative finite number`);
    }
  }
}

function format(value: number): string {
  return value.toFixed(6);
}
