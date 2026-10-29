import {Array as EffectArray} from 'effect';
import {Option} from 'effect';
import type {CodeGraphProgress} from '../types.js';

export type CodeGraphEtaBasis = 'cached-fact-bytes' | 'extraction-work' | 'files' | 'final-fact-bytes' | 'source-bytes';
export type CodeGraphEtaConfidence = 'high' | 'low' | 'medium';
export type CodeGraphEtaPhase = 'embedding' | 'materializing' | 'scanning';

export interface CodeGraphEtaMeasurement {
  readonly basis: CodeGraphEtaBasis;
  readonly completed: number;
  readonly phase: CodeGraphEtaPhase;
  readonly total: number;
}

interface ActiveCodeGraphEtaMeasurement extends CodeGraphEtaMeasurement {
  readonly lastCompleted: number;
  readonly lastSampleAtMilliseconds: number;
  readonly originCompleted: number;
  readonly originAtMilliseconds: number;
}

export interface CodeGraphEtaTracker {
  readonly intervalSamplesMilliseconds: readonly number[];
  readonly measurement: Option.Option<ActiveCodeGraphEtaMeasurement>;
  readonly rateForecastErrorSamples: readonly number[];
  readonly rateSamples: readonly number[];
  readonly sampleCount: number;
}

export interface CodeGraphEtaEstimate {
  readonly basis: CodeGraphEtaBasis;
  readonly confidence: 'high' | 'medium';
  readonly remainingMilliseconds: number;
}

export interface CodeGraphEtaObservation {
  readonly confidence: Option.Option<CodeGraphEtaConfidence>;
  readonly estimate: Option.Option<CodeGraphEtaEstimate>;
  readonly tracker: CodeGraphEtaTracker;
}

export interface CodeGraphEtaCalibration {
  readonly completed: number;
  readonly cumulativeRate: number;
  readonly intervalSamplesMilliseconds: readonly number[];
  readonly rateForecastErrorSamples: readonly number[];
  readonly rateSamples: readonly number[];
  readonly sampleCount: number;
  readonly silenceMilliseconds: number;
  readonly total: number;
}

const ETA_CALIBRATION_WINDOW = 24;
const ETA_MINIMUM_PROGRESS_FRACTION = 0.02;
const ETA_MEDIUM_PROGRESS_FRACTION = 0.1;
const ETA_HIGH_PROGRESS_FRACTION = 0.4;

export function makeCodeGraphEtaTracker(): CodeGraphEtaTracker {
  return {
    intervalSamplesMilliseconds: [],
    measurement: Option.none(),
    rateForecastErrorSamples: [],
    rateSamples: [],
    sampleCount: 0,
  };
}

export function codeGraphEtaMeasurement(progress: CodeGraphProgress): Option.Option<CodeGraphEtaMeasurement> {
  switch (progress.phase) {
    case 'scanning': {
      const metrics = progress.metrics;
      if (metrics && metrics.workUnitsTotal > 0) {
        return Option.some({
          basis: 'extraction-work',
          completed: Math.min(metrics.workUnitsCompleted, metrics.workUnitsTotal),
          phase: 'scanning',
          total: metrics.workUnitsTotal,
        });
      }
      if (metrics && metrics.sourceBytesTotal > 0) {
        return Option.some({
          basis: 'source-bytes',
          completed: Math.min(metrics.sourceBytesCompleted, metrics.sourceBytesTotal),
          phase: 'scanning',
          total: metrics.sourceBytesTotal,
        });
      }
      return Option.some({basis: 'files', completed: progress.completed, phase: 'scanning', total: progress.total});
    }
    case 'embedding':
      return Option.some({basis: 'files', completed: progress.completed, phase: progress.phase, total: progress.total});
    case 'materializing': {
      const metrics = progress.metrics;
      if (
        metrics?.factsBytesCompleted !== undefined &&
        metrics.factsBytesTotal !== undefined &&
        metrics.factsBytesTotal > 0
      ) {
        return Option.some({
          basis: 'final-fact-bytes',
          completed: Math.min(metrics.factsBytesCompleted, metrics.factsBytesTotal),
          phase: 'materializing',
          total: metrics.factsBytesTotal,
        });
      }
      if (
        metrics?.cachedFactBytesCompleted !== undefined &&
        metrics.cachedFactBytesTotal !== undefined &&
        metrics.cachedFactBytesTotal > 0
      ) {
        return Option.some({
          basis: 'cached-fact-bytes',
          completed: Math.min(metrics.cachedFactBytesCompleted, metrics.cachedFactBytesTotal),
          phase: 'materializing',
          total: metrics.cachedFactBytesTotal,
        });
      }
      if (metrics && metrics.sourceBytesTotal > 0) {
        return Option.some({
          basis: 'source-bytes',
          completed: Math.min(metrics.sourceBytesCompleted, metrics.sourceBytesTotal),
          phase: 'materializing',
          total: metrics.sourceBytesTotal,
        });
      }
      return Option.some({
        basis: 'files',
        completed: progress.completed,
        phase: 'materializing',
        total: progress.total,
      });
    }
    default:
      return Option.none();
  }
}

export function observeCodeGraphEta(
  current: CodeGraphEtaTracker,
  measurement: Option.Option<CodeGraphEtaMeasurement>,
  now: number,
): CodeGraphEtaObservation {
  if (Option.isNone(measurement)) {
    const tracker = makeCodeGraphEtaTracker();
    return {confidence: Option.none(), estimate: Option.none(), tracker};
  }

  const value = measurement.value;
  const active = Option.getOrUndefined(current.measurement);
  if (
    !active ||
    active.phase !== value.phase ||
    active.basis !== value.basis ||
    active.total !== value.total ||
    value.completed < active.lastCompleted
  ) {
    const tracker: CodeGraphEtaTracker = {
      ...makeCodeGraphEtaTracker(),
      measurement: Option.some({
        ...value,
        lastCompleted: value.completed,
        lastSampleAtMilliseconds: now,
        originAtMilliseconds: now,
        originCompleted: value.completed,
      }),
    };
    return {confidence: Option.none(), estimate: Option.none(), tracker};
  }

  let intervalSamplesMilliseconds = current.intervalSamplesMilliseconds;
  let rateForecastErrorSamples = current.rateForecastErrorSamples;
  let rateSamples = current.rateSamples;
  let sampleCount = current.sampleCount;
  let nextActive = active;
  if (value.completed > active.lastCompleted && now > active.lastSampleAtMilliseconds) {
    const interval = now - active.lastSampleAtMilliseconds;
    const observedRate = (value.completed - active.lastCompleted) / interval;
    const previousCumulativeRate = cumulativeRate(active, active.lastSampleAtMilliseconds);
    if (Option.isSome(previousCumulativeRate)) {
      rateForecastErrorSamples = appendEtaSample(
        rateForecastErrorSamples,
        symmetricDifference(observedRate, previousCumulativeRate.value),
      );
    }
    intervalSamplesMilliseconds = appendEtaSample(intervalSamplesMilliseconds, interval);
    rateSamples = appendEtaSample(rateSamples, observedRate);
    sampleCount += 1;
    nextActive = {
      ...active,
      completed: value.completed,
      lastCompleted: value.completed,
      lastSampleAtMilliseconds: now,
    };
  }

  const tracker: CodeGraphEtaTracker = {
    intervalSamplesMilliseconds,
    measurement: Option.some(nextActive),
    rateForecastErrorSamples,
    rateSamples,
    sampleCount,
  };
  return estimateCodeGraphEta(tracker, now);
}

export function estimateCodeGraphEta(tracker: CodeGraphEtaTracker, now: number): CodeGraphEtaObservation {
  const measurement = Option.getOrUndefined(tracker.measurement);
  if (!measurement || measurement.lastCompleted >= measurement.total) {
    return {confidence: Option.none(), estimate: Option.none(), tracker};
  }
  const rate = cumulativeRate(measurement, now);
  if (Option.isNone(rate)) return {confidence: Option.none(), estimate: Option.none(), tracker};
  const confidence = calibratedCodeGraphEtaConfidence({
    completed: measurement.lastCompleted,
    cumulativeRate: rate.value,
    intervalSamplesMilliseconds: tracker.intervalSamplesMilliseconds,
    rateForecastErrorSamples: tracker.rateForecastErrorSamples,
    rateSamples: tracker.rateSamples,
    sampleCount: tracker.sampleCount,
    silenceMilliseconds: Math.max(0, now - measurement.lastSampleAtMilliseconds),
    total: measurement.total,
  });
  if (confidence !== 'high' && confidence !== 'medium') {
    return {confidence: Option.fromNullishOr(confidence), estimate: Option.none(), tracker};
  }
  const remaining = Math.max(0, measurement.total - measurement.lastCompleted) / rate.value;
  return {
    confidence: Option.some(confidence),
    estimate: Option.some({
      basis: measurement.basis,
      confidence,
      remainingMilliseconds: roundUpToSecond(remaining),
    }),
    tracker,
  };
}

/**
 * Calibrates a phase-local estimate. The numeric ETA uses cumulative throughput;
 * recent rates only decide whether that estimate is stable enough to publish.
 */
export function calibratedCodeGraphEtaConfidence(input: CodeGraphEtaCalibration): CodeGraphEtaConfidence | undefined {
  if (input.sampleCount < 4 || input.rateSamples.length < 4 || input.total <= 0) return undefined;
  const progressFraction = input.completed / input.total;
  if (progressFraction < ETA_MINIMUM_PROGRESS_FRACTION) return undefined;
  const typicalInterval = median(input.intervalSamplesMilliseconds) ?? 0;
  const variation = coefficientOfVariation(input.rateSamples);
  const rateForecastError = mean(input.rateForecastErrorSamples);
  const recentRate = median(input.rateSamples);
  const drift =
    recentRate === undefined ? Number.POSITIVE_INFINITY : symmetricDifference(recentRate, input.cumulativeRate);
  if (
    input.silenceMilliseconds > Math.max(5_000, typicalInterval * 4) ||
    drift > 0.5 ||
    variation > 0.75 ||
    rateForecastError > 0.75
  ) {
    return 'low';
  }
  if (
    input.sampleCount >= 24 &&
    input.rateForecastErrorSamples.length >= 20 &&
    progressFraction >= ETA_HIGH_PROGRESS_FRACTION &&
    drift <= 0.2 &&
    variation <= 0.2 &&
    rateForecastError <= 0.25
  ) {
    return 'high';
  }
  if (
    input.sampleCount >= 8 &&
    input.rateForecastErrorSamples.length >= 6 &&
    progressFraction >= ETA_MEDIUM_PROGRESS_FRACTION &&
    drift <= 0.35 &&
    variation <= 0.5 &&
    rateForecastError <= 0.5
  ) {
    return 'medium';
  }
  return 'low';
}

function cumulativeRate(measurement: ActiveCodeGraphEtaMeasurement, now: number): Option.Option<number> {
  const elapsed = now - measurement.originAtMilliseconds;
  const completed = measurement.lastCompleted - measurement.originCompleted;
  if (elapsed <= 0 || completed <= 0) return Option.none();
  const rate = completed / elapsed;
  return Number.isFinite(rate) && rate > 0 ? Option.some(rate) : Option.none();
}

function appendEtaSample(samples: readonly number[], sample: number): readonly number[] {
  return [...samples, sample].slice(-ETA_CALIBRATION_WINDOW);
}

function coefficientOfVariation(values: readonly number[]): number {
  const average = mean(values);
  if (average <= 0 || !Number.isFinite(average)) return Number.POSITIVE_INFINITY;
  const variance = EffectArray.reduce(values, 0, (total, value) => total + (value - average) ** 2) / values.length;
  return Math.sqrt(variance) / average;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? Number.POSITIVE_INFINITY
    : EffectArray.reduce(values, 0, (total, value) => total + value) / values.length;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function roundUpToSecond(milliseconds: number): number {
  return Math.ceil(Math.max(0, milliseconds) / 1_000) * 1_000;
}

function symmetricDifference(left: number, right: number): number {
  return Math.abs(left - right) / Math.max(left, right, Number.EPSILON);
}
