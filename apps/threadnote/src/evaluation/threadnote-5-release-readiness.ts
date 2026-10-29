import {pipe as EffectArrayPipe} from 'effect';
import {Array as EffectArray, Option as EffectOption, Predicate} from 'effect';
import {
  parseThreadnote5ReleaseEvidenceV1,
  parseThreadnote5ReleaseReadinessFixtureV1,
  parseThreadnote5TrustedSourceV1,
  threadnote5ReleaseReadinessFixtureHash,
  THREADNOTE_5_BASELINE_VERSION,
  type Threadnote5MeasurementV1,
  type Threadnote5BaselineV1,
  type Threadnote5MetricDefinitionV1,
  type Threadnote5ObservationV1,
  type Threadnote5ReleaseMetric,
  type Threadnote5ReleaseReadinessFixtureV1,
  type Threadnote5ReleaseScenario,
  type Threadnote5ScenarioContractV1,
  type Threadnote5SourceV1,
} from './threadnote-5-release-readiness-contract.js';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {
  verifyThreadnote5LocalSubsystemReceipts,
  type Threadnote5LocalReceiptVerificationV1,
} from './threadnote-5-release-readiness-receipts.js';
import {
  parseThreadnote5BaselineTrialLedger,
  threadnote5BaselineTrialLedger,
  threadnote5BaselineTrialLedgerHash,
} from './threadnote-5-release-readiness-baseline-ledger.js';

export interface Threadnote5ObservedMetricV1 {
  readonly sourceVersion: string;
  readonly state: 'observed';
  readonly value: number;
}

export type Threadnote5UnknownMetricReason =
  'baseline-unavailable' | 'baseline-untrusted' | 'capture-untrusted' | 'source-incomplete';

export interface Threadnote5UnknownMetricV1 {
  readonly reason: Threadnote5UnknownMetricReason;
  readonly sourceVersion: string;
  readonly state: 'unknown';
}

export interface Threadnote5NotApplicableMetricV1 {
  readonly reason: 'introduced-in-threadnote-5';
  readonly sourceVersion: typeof THREADNOTE_5_BASELINE_VERSION;
  readonly state: 'not-applicable';
}

export type Threadnote5MetricValueV1 =
  Threadnote5NotApplicableMetricV1 | Threadnote5ObservedMetricV1 | Threadnote5UnknownMetricV1;

export interface Threadnote5MetricComparisonV1 {
  readonly baseline: Threadnote5MetricValueV1;
  readonly candidate: Threadnote5MetricValueV1;
  readonly delta:
    | {
        readonly classification: 'improved' | 'regressed' | 'unchanged';
        readonly state: 'observed';
        readonly value: number;
      }
    | {readonly reason: Threadnote5UnknownMetricReason; readonly state: 'unknown'}
    | {readonly reason: Threadnote5NotApplicableMetricV1['reason']; readonly state: 'not-applicable'};
  readonly direction: 'higher' | 'lower';
  readonly id: Threadnote5ReleaseMetric;
  readonly threshold: number;
  readonly thresholdKind: 'maximum' | 'minimum';
  readonly thresholdPassed: boolean | null;
  readonly unit: 'milliseconds' | 'ratio' | 'tokens';
}

export interface Threadnote5ReleaseReadinessResultV1 {
  readonly candidate: Threadnote5SourceV1;
  readonly evidence: {
    readonly captureManifestTrusted: boolean;
    readonly captureMode: 'fixture-replay' | 'release-candidate';
    readonly hash: string;
    readonly productionReceiptVerification: Threadnote5LocalReceiptVerificationV1 | null;
  };
  readonly fixture: {readonly hash: string; readonly scenarioCount: number};
  readonly gate: {
    readonly insufficiencies: readonly string[];
    readonly qualityFailures: readonly string[];
    readonly status: 'failed' | 'passed' | 'unknown';
  };
  readonly metrics: readonly Threadnote5MetricComparisonV1[];
  readonly scenarios: readonly {
    readonly id: Threadnote5ReleaseScenario;
    readonly observationReceiptHash: string | null;
    readonly state: 'failed' | 'missing' | 'passed' | 'unknown';
  }[];
  readonly version: 1;
}

export function evaluateThreadnote5ReleaseReadiness(input: {
  readonly evidence: unknown;
  readonly expectedBaselineSource?: unknown;
  readonly expectedBaselineTrialLedgerSha256?: string;
  readonly expectedCandidateCommit: string;
  readonly expectedCandidateExecutableSha256: string;
  readonly expectedCaptureManifestSha256: string;
  readonly expectedLocalAuthorityManifestSha256?: string;
  readonly fixture: unknown;
  readonly baselineTrialLedger?: unknown;
  readonly localAuthorityManifest?: unknown;
  readonly retainedSubsystemReceiptRecords?: unknown;
}): Threadnote5ReleaseReadinessResultV1 {
  const fixture = parseThreadnote5ReleaseReadinessFixtureV1(input.fixture);
  const evidence = parseThreadnote5ReleaseEvidenceV1(input.evidence, fixture);
  assertExpectedCandidate(evidence.candidate, input);

  const qualityFailures: string[] = [];
  const insufficiencies: string[] = [];
  const captureTrusted = evidence.capture.manifestHash === input.expectedCaptureManifestSha256;
  if (!captureTrusted) qualityFailures.push('capture manifest does not match the trusted expected hash');
  const productionReceiptVerification =
    evidence.capture.manifest.mode === 'release-candidate'
      ? verifyThreadnote5LocalSubsystemReceipts({
          authorityManifest: input.localAuthorityManifest,
          candidate: evidence.candidate,
          expectedAuthorityManifestSha256: input.expectedLocalAuthorityManifestSha256,
          observations: evidence.candidateObservations,
          retainedRecords: input.retainedSubsystemReceiptRecords,
        })
      : null;
  const verifiedCandidateScenarios =
    productionReceiptVerification === null
      ? undefined
      : new Set(
          EffectArray.map(
            EffectArray.filter(productionReceiptVerification.scenarios, scenario => scenario.state === 'verified'),
            scenario => scenario.scenario,
          ),
        );
  const verifierIncomplete =
    productionReceiptVerification?.state === 'unknown' &&
    productionReceiptVerification.reason === 'verifier-incomplete';
  const scenarios = EffectArray.map(fixture.scenarios, contract => {
    const observation = EffectOption.getOrUndefined(
      EffectArray.findFirst(evidence.candidateObservations, item => item.scenario === contract.id),
    );
    const state: 'failed' | 'missing' | 'passed' | 'unknown' = captureTrusted
      ? verifiedCandidateScenarios === undefined || verifiedCandidateScenarios.has(contract.id)
        ? observationState(contract, observation)
        : 'unknown'
      : 'unknown';
    if (state !== 'passed') {
      if (state === 'unknown' && verifierIncomplete && !verifiedCandidateScenarios?.has(contract.id)) {
        insufficiencies.push(`candidate scenario ${contract.id} lacks a complete source verifier`);
      } else {
        qualityFailures.push(`candidate scenario ${contract.id} is ${state}`);
      }
    }
    return {id: contract.id, observationReceiptHash: observation?.receiptHash ?? null, state};
  });

  const candidateMetrics = captureTrusted
    ? aggregateMetrics(fixture, evidence.candidate, evidence.candidateObservations, verifiedCandidateScenarios)
    : unknownMetrics(fixture, evidence.candidate.version, 'capture-untrusted');
  const expectedBaseline =
    input.expectedBaselineSource === undefined
      ? undefined
      : parseThreadnote5TrustedSourceV1(input.expectedBaselineSource, 'baseline');
  const baselineLedgerTrusted =
    input.expectedBaselineTrialLedgerSha256 !== undefined &&
    input.baselineTrialLedger !== undefined &&
    threadnote5BaselineTrialLedgerHash(baselineLedgerValue(input.baselineTrialLedger)) ===
      input.expectedBaselineTrialLedgerSha256 &&
    evidence.baseline.state === 'available' &&
    canonicalBaselineLedgerMatches(
      parseThreadnote5BaselineTrialLedger(baselineLedgerValue(input.baselineTrialLedger)),
      evidence.baseline,
    );
  const baselineTrusted =
    evidence.baseline.state === 'available' &&
    expectedBaseline !== undefined &&
    sameSource(evidence.baseline.source, expectedBaseline) &&
    baselineLedgerTrusted;
  const baselineMetrics =
    evidence.baseline.state === 'unavailable'
      ? unavailableBaselineMetrics(fixture, 'baseline-unavailable')
      : captureTrusted && baselineTrusted
        ? aggregateBaselineMetrics(fixture, evidence.baseline.source, evidence.baseline.observations)
        : unavailableBaselineMetrics(fixture, captureTrusted ? 'baseline-untrusted' : 'capture-untrusted');
  const metrics = EffectArray.map(fixture.metrics, definition => {
    const candidate = candidateMetrics.get(definition.id)!;
    const baseline = baselineMetrics.get(definition.id)!;
    const thresholdPassed = candidate.state === 'observed' ? passesThreshold(definition, candidate.value) : null;
    if (thresholdPassed !== true) {
      const dependsOnIncompleteVerifier =
        verifierIncomplete &&
        EffectArray.some(
          EffectArrayPipe(fixture.scenarios, __effectArrayValues =>
            EffectArray.filter(
              __effectArrayValues,
              (scenario, __effectArrayIndex) =>
                __effectArrayIndex in __effectArrayValues && scenario.metricIds.includes(definition.id),
            ),
          ),
          scenario => !verifiedCandidateScenarios?.has(scenario.id),
        );
      if (thresholdPassed === null && dependsOnIncompleteVerifier) {
        insufficiencies.push(`candidate metric ${definition.id} lacks a complete source verifier`);
      } else {
        qualityFailures.push(
          thresholdPassed === false
            ? `candidate metric ${definition.id} misses its ${definition.thresholdKind} threshold`
            : `candidate metric ${definition.id} is unknown`,
        );
      }
    }
    return {
      baseline,
      candidate,
      delta: compareMetric(definition, baseline, candidate),
      direction: definition.direction,
      id: definition.id,
      threshold: definition.threshold,
      thresholdKind: definition.thresholdKind,
      thresholdPassed,
      unit: definition.unit,
    };
  });

  if (evidence.capture.manifest.mode !== 'release-candidate') {
    insufficiencies.push('sealed fixture replay is not production release evidence');
  } else if (productionReceiptVerification?.state !== 'verified') {
    insufficiencies.push(
      `production subsystem receipt verification is ${
        productionReceiptVerification === null ? 'records-unavailable' : productionReceiptVerification.reason
      }`,
    );
  }
  if (evidence.baseline.state === 'unavailable') {
    insufficiencies.push(`4.7.8 baseline is unavailable: ${evidence.baseline.reason}`);
  } else if (!baselineTrusted) {
    insufficiencies.push('4.7.8 baseline does not match its trusted identity, executable, and ledger');
  } else {
    for (const [id, metric] of baselineMetrics) {
      if (metric.state === 'unknown') insufficiencies.push(`4.7.8 baseline metric is unknown: ${id}`);
    }
  }
  const uniqueFailures = [...new Set(qualityFailures)].sort();
  const uniqueInsufficiencies = [...new Set(insufficiencies)].sort();
  return {
    candidate: evidence.candidate,
    evidence: {
      captureManifestTrusted: captureTrusted,
      captureMode: evidence.capture.manifest.mode,
      hash: evidence.evidenceHash,
      productionReceiptVerification,
    },
    fixture: {hash: threadnote5ReleaseReadinessFixtureHash(fixture), scenarioCount: fixture.scenarios.length},
    gate: {
      insufficiencies: uniqueInsufficiencies,
      qualityFailures: uniqueFailures,
      status: uniqueFailures.length > 0 ? 'failed' : uniqueInsufficiencies.length > 0 ? 'unknown' : 'passed',
    },
    metrics,
    scenarios,
    version: 1,
  };
}

function aggregateMetrics(
  fixture: Threadnote5ReleaseReadinessFixtureV1,
  source: Threadnote5SourceV1,
  observations: readonly Threadnote5ObservationV1[],
  verifiedScenarios?: ReadonlySet<Threadnote5ReleaseScenario>,
): ReadonlyMap<Threadnote5ReleaseMetric, Threadnote5MetricValueV1> {
  return new Map(
    EffectArray.map(fixture.metrics, definition => {
      const requiredScenarios = EffectArrayPipe(fixture.scenarios, __effectArrayValues =>
        EffectArray.filter(
          __effectArrayValues,
          (scenario, __effectArrayIndex) =>
            __effectArrayIndex in __effectArrayValues && scenario.metricIds.includes(definition.id),
        ),
      );
      const selected = EffectArray.map(requiredScenarios, contract => ({
        contract,
        observation: EffectOption.getOrUndefined(
          EffectArray.findFirst(observations, item => item.scenario === contract.id),
        ),
      }));
      const measurements = EffectArray.map(selected, ({contract, observation}) => {
        if (verifiedScenarios !== undefined && !verifiedScenarios.has(contract.id)) return undefined;
        if (observation?.transcript.outcome !== 'passed') return undefined;
        const measurement = EffectOption.getOrUndefined(
          EffectArray.findFirst(observation.transcript.measurements, item => item.id === definition.id),
        );
        const minimum = EffectOption.getOrUndefined(
          EffectArray.findFirst(contract.metricMinimums, item => item.id === definition.id),
        );
        if (
          measurement === undefined ||
          minimum === undefined ||
          measurementEligibleCount(measurement) < minimum.minimumEligibleCount
        ) {
          return undefined;
        }
        return measurement;
      });
      const completeMeasurements = EffectArray.filter(measurements, Predicate.isNotUndefined);
      if (completeMeasurements.length !== measurements.length) {
        return [
          definition.id,
          {
            reason: 'source-incomplete',
            sourceVersion: source.version,
            state: 'unknown',
          } satisfies Threadnote5UnknownMetricV1,
        ] as const;
      }
      return [definition.id, observedMetric(source.version, definition, completeMeasurements)] as const;
    }),
  );
}

function observationState(
  contract: Threadnote5ScenarioContractV1,
  observation: Threadnote5ObservationV1 | undefined,
): 'failed' | 'missing' | 'passed' | 'unknown' {
  if (observation === undefined) return 'missing';
  if (observation.transcript.outcome !== 'passed') return observation.transcript.outcome;
  const measurements = new Map(
    EffectArray.map(observation.transcript.measurements, measurement => [measurement.id, measurement]),
  );
  const hasMinimumTrials = EffectArray.every(contract.metricMinimums, minimum => {
    const measurement = measurements.get(minimum.id);
    return measurement !== undefined && measurementEligibleCount(measurement) >= minimum.minimumEligibleCount;
  });
  return hasMinimumTrials ? 'passed' : 'unknown';
}

function measurementEligibleCount(measurement: Threadnote5MeasurementV1): number {
  return 'sampleCount' in measurement ? measurement.sampleCount : measurement.eligibleCount;
}

function observedMetric(
  sourceVersion: string,
  definition: Threadnote5MetricDefinitionV1,
  measurements: readonly Threadnote5MeasurementV1[],
): Threadnote5MetricValueV1 {
  if (definition.kind === 'mean') {
    const aggregate = EffectArray.reduce(measurements, {count: 0, total: 0}, (result, measurement) => ({
      count: result.count + ('sampleCount' in measurement ? measurement.sampleCount : 0),
      total: result.total + ('total' in measurement ? measurement.total : 0),
    }));
    if (aggregate.count === 0) return {reason: 'source-incomplete', sourceVersion, state: 'unknown'};
    return {sourceVersion, state: 'observed', value: aggregate.total / aggregate.count};
  }
  const aggregate = EffectArray.reduce(measurements, {eligible: 0, positive: 0}, (result, measurement) => ({
    eligible: result.eligible + ('eligibleCount' in measurement ? measurement.eligibleCount : 0),
    positive: result.positive + ('positiveCount' in measurement ? measurement.positiveCount : 0),
  }));
  if (aggregate.eligible === 0) return {reason: 'source-incomplete', sourceVersion, state: 'unknown'};
  return {sourceVersion, state: 'observed', value: aggregate.positive / aggregate.eligible};
}

function unknownMetrics(
  fixture: Threadnote5ReleaseReadinessFixtureV1,
  sourceVersion: string,
  reason: Threadnote5UnknownMetricReason,
): ReadonlyMap<Threadnote5ReleaseMetric, Threadnote5MetricValueV1> {
  return new Map(
    EffectArray.map(fixture.metrics, definition => [
      definition.id,
      {reason, sourceVersion, state: 'unknown'} satisfies Threadnote5UnknownMetricV1,
    ]),
  );
}

function aggregateBaselineMetrics(
  fixture: Threadnote5ReleaseReadinessFixtureV1,
  source: Threadnote5SourceV1,
  observations: readonly Threadnote5ObservationV1[],
): ReadonlyMap<Threadnote5ReleaseMetric, Threadnote5MetricValueV1> {
  const comparable = new Set(fixture.baselineComparison.comparableMetricIds);
  const aggregated = aggregateMetrics(fixture, source, observations);
  return new Map(
    EffectArray.map(fixture.metrics, definition => [
      definition.id,
      comparable.has(definition.id) ? aggregated.get(definition.id)! : notApplicableBaselineMetric(),
    ]),
  );
}

function unavailableBaselineMetrics(
  fixture: Threadnote5ReleaseReadinessFixtureV1,
  reason: Threadnote5UnknownMetricReason,
): ReadonlyMap<Threadnote5ReleaseMetric, Threadnote5MetricValueV1> {
  const comparable = new Set(fixture.baselineComparison.comparableMetricIds);
  return new Map(
    EffectArray.map(fixture.metrics, definition => [
      definition.id,
      comparable.has(definition.id)
        ? ({
            reason,
            sourceVersion: THREADNOTE_5_BASELINE_VERSION,
            state: 'unknown',
          } satisfies Threadnote5UnknownMetricV1)
        : notApplicableBaselineMetric(),
    ]),
  );
}

function notApplicableBaselineMetric(): Threadnote5NotApplicableMetricV1 {
  return {
    reason: 'introduced-in-threadnote-5',
    sourceVersion: THREADNOTE_5_BASELINE_VERSION,
    state: 'not-applicable',
  };
}

function compareMetric(
  definition: Threadnote5MetricDefinitionV1,
  baseline: Threadnote5MetricValueV1,
  candidate: Threadnote5MetricValueV1,
): Threadnote5MetricComparisonV1['delta'] {
  if (baseline.state === 'not-applicable' || candidate.state === 'not-applicable') {
    return {reason: 'introduced-in-threadnote-5', state: 'not-applicable'};
  }
  if (baseline.state === 'unknown' || candidate.state === 'unknown') {
    return {
      reason:
        baseline.state === 'unknown'
          ? baseline.reason
          : candidate.state === 'unknown'
            ? candidate.reason
            : 'source-incomplete',
      state: 'unknown',
    };
  }
  const value = candidate.value - baseline.value;
  const classification =
    value === 0
      ? 'unchanged'
      : (definition.direction === 'higher' && value > 0) || (definition.direction === 'lower' && value < 0)
        ? 'improved'
        : 'regressed';
  return {classification, state: 'observed', value};
}

function passesThreshold(definition: Threadnote5MetricDefinitionV1, value: number): boolean {
  return definition.thresholdKind === 'maximum' ? value <= definition.threshold : value >= definition.threshold;
}

function assertExpectedCandidate(
  candidate: Threadnote5SourceV1,
  expected: {readonly expectedCandidateCommit: string; readonly expectedCandidateExecutableSha256: string},
): void {
  if (candidate.commit !== expected.expectedCandidateCommit) {
    throw new Error('Release-readiness evidence candidate commit does not match the requested candidate.');
  }
  if (candidate.executableSha256 !== expected.expectedCandidateExecutableSha256) {
    throw new Error('Release-readiness evidence executable hash does not match the requested candidate.');
  }
}

function sameSource(left: Threadnote5SourceV1, right: Threadnote5SourceV1): boolean {
  return (
    left.commit === right.commit &&
    left.executableSha256 === right.executableSha256 &&
    left.id === right.id &&
    left.version === right.version
  );
}

function canonicalBaselineLedgerMatches(
  ledger: ReturnType<typeof parseThreadnote5BaselineTrialLedger>,
  baseline: Extract<Threadnote5BaselineV1, {readonly state: 'available'}>,
): boolean {
  return (
    sameSource(ledger.source, baseline.source) &&
    canonicalJson(ledger) === canonicalJson(threadnote5BaselineTrialLedger(baseline.source, baseline.observations))
  );
}

function baselineLedgerValue(value: unknown): unknown {
  if (!Predicate.isObject(value)) return value;
  const source = value;
  return source.ledger === undefined ? value : source.ledger;
}
