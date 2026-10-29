import {isSafeInteger as checkedIsSafeInteger} from '@threadnote/platform/validation';
import {Array as EffectArray, Predicate} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {
  parseThreadnote5TrustedSourceV1,
  THREADNOTE_5_BASELINE_COMPARABLE_METRICS,
  THREADNOTE_5_RELEASE_SCENARIOS,
  type Threadnote5MeasurementV1,
  type Threadnote5ObservationOutcome,
  type Threadnote5ObservationV1,
  type Threadnote5ReleaseScenario,
  type Threadnote5SourceV1,
} from './threadnote-5-release-readiness-contract.js';
import * as EffectRecord from 'effect/Record';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

export const THREADNOTE_5_BASELINE_LEDGER_VERSION = 1 as const;

export type Threadnote5BaselineComparableMetricV1 = (typeof THREADNOTE_5_BASELINE_COMPARABLE_METRICS)[number];
const baselineComparableMetricSet: ReadonlySet<string> = new Set(THREADNOTE_5_BASELINE_COMPARABLE_METRICS);

export type Threadnote5BaselineMeasurementV1 =
  | {
      readonly id: 'estimated-tokens-to-first-cited-correct-plan' | 'time-to-first-cited-correct-plan';
      readonly sampleCount: number;
      readonly total: number;
    }
  | {
      readonly eligibleCount: number;
      readonly id: 'wrong-memory-rate';
      readonly positiveCount: number;
    };

/** Content-free capture index; its hash is supplied separately and never self-nominates trust. */
export interface Threadnote5BaselineTrialLedgerV1 {
  readonly observations: readonly {
    readonly measurements: readonly Threadnote5BaselineMeasurementV1[];
    readonly outcome: Threadnote5ObservationOutcome;
    readonly receiptHash: string;
    readonly scenario: Threadnote5ReleaseScenario;
    readonly transcriptDigest: string;
  }[];
  readonly source: Threadnote5SourceV1;
  readonly version: typeof THREADNOTE_5_BASELINE_LEDGER_VERSION;
}

export function threadnote5BaselineTrialLedger(
  source: Threadnote5SourceV1,
  observations: readonly Threadnote5ObservationV1[],
): Threadnote5BaselineTrialLedgerV1 {
  return {
    observations: EffectArray.flatMap(observations, observation => {
      const measurements = baselineMeasurements(observation.transcript.measurements);
      return measurements.length === 0
        ? []
        : [
            {
              measurements,
              outcome: observation.transcript.outcome,
              receiptHash: observation.receiptHash,
              scenario: observation.scenario,
              transcriptDigest: observation.attestation.transcriptDigest,
            },
          ];
    }).sort(compareLedgerObservation),
    source: parseThreadnote5TrustedSourceV1(source, 'baseline'),
    version: THREADNOTE_5_BASELINE_LEDGER_VERSION,
  };
}

export function threadnote5BaselineTrialLedgerHash(value: unknown): string {
  return sha256HexSync(
    `threadnote-5-baseline-trial-ledger-v1\0${canonicalJson(parseThreadnote5BaselineTrialLedger(value))}`,
  );
}

export function parseThreadnote5BaselineTrialLedger(value: unknown): Threadnote5BaselineTrialLedgerV1 {
  if (!Predicate.isObject(value)) throw new Error('Baseline trial ledger must be an object.');
  const source = value;
  if (canonicalJson(EffectRecord.keys(source).sort()) !== canonicalJson(['observations', 'source', 'version'])) {
    throw new Error('Baseline trial ledger has unsupported or missing fields.');
  }
  if (source.version !== 1 || !EffectArray.isArray(source.observations)) {
    throw new Error('Baseline trial ledger version or observations are invalid.');
  }
  const observations = EffectArray.map(source.observations, observation => {
    if (!Predicate.isObject(observation)) throw new Error('Baseline trial ledger observation is invalid.');
    const item = observation;
    if (
      canonicalJson(EffectRecord.keys(item).sort()) !==
      canonicalJson(['measurements', 'outcome', 'receiptHash', 'scenario', 'transcriptDigest'])
    )
      throw new Error('Baseline trial ledger observation has unsupported fields.');
    if (!EffectArray.isArray(item.measurements) || item.measurements.length === 0)
      throw new Error('Baseline trial ledger observation is invalid.');
    const measurements = EffectArray.map(item.measurements, parseBaselineMeasurement);
    if (
      new Set(EffectArray.map(measurements, measurement => measurement.id)).size !== measurements.length ||
      canonicalJson(EffectArray.map(measurements, measurement => measurement.id)) !==
        canonicalJson(
          EffectArray.map([...measurements].sort(compareBaselineMeasurement), measurement => measurement.id),
        )
    ) {
      throw new Error('Baseline trial ledger measurements must be unique and sorted.');
    }
    return {
      measurements,
      outcome: literal(item.outcome, ['failed', 'passed', 'unknown'] as const, 'baseline outcome'),
      receiptHash: hash(item.receiptHash),
      scenario: literal(item.scenario, THREADNOTE_5_RELEASE_SCENARIOS, 'baseline scenario'),
      transcriptDigest: hash(item.transcriptDigest),
    };
  });
  if (
    observations.length > 15 ||
    new Set(EffectArray.map(observations, item => item.receiptHash)).size !== observations.length ||
    new Set(EffectArray.map(observations, item => item.scenario)).size !== observations.length ||
    canonicalJson(observations) !== canonicalJson([...observations].sort(compareLedgerObservation))
  ) {
    throw new Error('Baseline trial ledger observations must be unique, sorted, and bounded.');
  }
  return {observations, source: parseThreadnote5TrustedSourceV1(source.source, 'baseline'), version: 1};
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    throw new Error('Baseline trial ledger hash is invalid.');
  return value;
}

function baselineMeasurements(measurements: readonly Threadnote5MeasurementV1[]): Threadnote5BaselineMeasurementV1[] {
  return EffectArray.flatMap(measurements, measurement =>
    baselineComparableMetricSet.has(measurement.id) ? [parseBaselineMeasurement(measurement)] : [],
  ).sort(compareBaselineMeasurement);
}

function parseBaselineMeasurement(value: unknown): Threadnote5BaselineMeasurementV1 {
  if (!Predicate.isObject(value)) {
    throw new Error('Baseline trial ledger measurement is invalid.');
  }
  const measurement = value;
  if (
    measurement.id === 'time-to-first-cited-correct-plan' ||
    measurement.id === 'estimated-tokens-to-first-cited-correct-plan'
  ) {
    exactKeys(measurement, ['id', 'sampleCount', 'total'], 'Baseline trial ledger mean measurement');
    return {
      id: measurement.id,
      sampleCount: boundedInteger(measurement.sampleCount, 1, 10_000),
      total: boundedInteger(measurement.total, 0, 1_000_000_000_000),
    };
  }
  if (measurement.id === 'wrong-memory-rate') {
    exactKeys(measurement, ['eligibleCount', 'id', 'positiveCount'], 'Baseline trial ledger feedback measurement');
    const eligibleCount = boundedInteger(measurement.eligibleCount, 1, 10_000);
    return {
      eligibleCount,
      id: 'wrong-memory-rate',
      positiveCount: boundedInteger(measurement.positiveCount, 0, eligibleCount),
    };
  }
  throw new Error('Baseline trial ledger metric is not comparable with Threadnote 4.7.8.');
}

function compareBaselineMeasurement(
  left: Threadnote5BaselineMeasurementV1,
  right: Threadnote5BaselineMeasurementV1,
): number {
  return (
    THREADNOTE_5_BASELINE_COMPARABLE_METRICS.indexOf(left.id) -
    THREADNOTE_5_BASELINE_COMPARABLE_METRICS.indexOf(right.id)
  );
}

function compareLedgerObservation(
  left: Threadnote5BaselineTrialLedgerV1['observations'][number],
  right: Threadnote5BaselineTrialLedgerV1['observations'][number],
): number {
  if (left.scenario !== right.scenario) return Effect.pipe(left.scenario, EffectString.localeCompare(right.scenario));
  return Effect.pipe(left.receiptHash, EffectString.localeCompare(right.receiptHash));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (canonicalJson(EffectRecord.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!checkedIsSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('Baseline trial ledger measurement count is invalid.');
  }
  return value;
}

function literal<const Value extends string>(value: unknown, allowed: readonly Value[], label: string): Value {
  if (typeof value === 'string') {
    for (const candidate of allowed) {
      if (candidate === value) return candidate;
    }
  }
  throw new Error(`Baseline trial ledger ${label} is invalid.`);
}
