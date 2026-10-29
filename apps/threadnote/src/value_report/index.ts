import {Array as EffectArray} from 'effect';
import {Schema} from 'effect';
import {summarizeRecallFeedback, type RecallFeedbackEvent} from '@threadnote/recall/feedback';

export const VALUE_REPORT_VERSION = 1 as const;
export const VALUE_REPORT_MAX_COUNT = 10_000;
export const VALUE_REPORT_MAX_DURATION_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
export const VALUE_REPORT_MAX_TIMING_SAMPLES = 1_024;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const boundedCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(VALUE_REPORT_MAX_COUNT),
);
const boundedDuration = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(VALUE_REPORT_MAX_DURATION_MILLISECONDS),
);
const rate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1));
const isoInstant = Schema.String.check(Schema.isPattern(ISO_INSTANT));

export interface ValueReportPeriodV1 {
  readonly from: string;
  readonly to: string;
}

export interface ValueReportContextBriefV1 {
  readonly attempts: number;
  readonly successful: number;
  readonly requestedCodeAnchors: number;
  readonly resolvedCodeAnchors: number;
  readonly coverageGaps: number;
  readonly estimatedTokens: number;
  readonly followUpGraphOperations: number;
  readonly followUpRecallOperations: number;
  readonly followUpOperations: number;
  readonly timeToFirstSuccessfulMilliseconds?: number;
}

export interface ValueReportFeedbackV1 {
  readonly applied: number;
  readonly dismiss: number;
  readonly pin: number;
  readonly useful: number;
  readonly wrong: number;
  readonly total: number;
  readonly appliedRate: number;
  readonly dismissRate: number;
  readonly pinRate: number;
  readonly usefulRate: number;
  readonly wrongRate: number;
}

export interface ValueReportKnowledgeDeltaV1 {
  readonly proposed: number;
  readonly approved: number;
  readonly edited: number;
  readonly rejected: number;
  readonly deferred: number;
}

export interface ValueReportHealthV1 {
  readonly opened: number;
  readonly resolved: number;
}

export interface ValueReportSetupV1 {
  readonly availability: 'available' | 'unavailable';
  readonly completed: number;
  readonly failed: number;
  readonly started: number;
  readonly supportedAgentReuse: number;
  readonly timeToFirstEvidenceMilliseconds?: number;
}

export interface ValueReportSetupInputV1 extends Partial<ValueReportSetupV1> {
  readonly timeToFirstEvidenceMillisecondsSamples?: readonly number[];
}

export interface ValueReportV1 {
  readonly type: 'value-report';
  readonly version: typeof VALUE_REPORT_VERSION;
  readonly scope: 'local';
  readonly period: ValueReportPeriodV1;
  readonly contextBrief: ValueReportContextBriefV1;
  readonly feedback: ValueReportFeedbackV1;
  readonly knowledgeDelta: ValueReportKnowledgeDeltaV1;
  readonly health: ValueReportHealthV1;
  readonly setup: ValueReportSetupV1;
}

export interface ValueReportContextBriefInputV1 {
  readonly attempts?: number;
  readonly successful?: number;
  readonly requestedCodeAnchors?: number;
  readonly resolvedCodeAnchors?: number;
  readonly coverageGaps?: number;
  readonly estimatedTokens?: number;
  readonly followUpGraphOperations?: number;
  readonly followUpRecallOperations?: number;
  readonly timeToFirstSuccessfulMilliseconds?: number;
  readonly timeToFirstSuccessfulMillisecondsSamples?: readonly number[];
}

export interface ValueReportCountsInputV1 {
  readonly contextBrief?: ValueReportContextBriefInputV1;
  readonly knowledgeDelta?: Partial<ValueReportKnowledgeDeltaV1>;
  readonly health?: Partial<ValueReportHealthV1>;
  readonly setup?: ValueReportSetupInputV1;
}

export interface ValueReportInputV1 {
  readonly period: ValueReportPeriodV1;
  readonly feedbackEvents?: readonly RecallFeedbackEvent[];
  /** A project filters local feedback only; the project label is never output. */
  readonly project?: string;
  readonly counts?: ValueReportCountsInputV1;
}

export type ValueReport = ValueReportV1;
export type ValueReportInput = ValueReportInputV1;

export const ValueReportV1Schema = Schema.Struct({
  contextBrief: Schema.Struct({
    attempts: boundedCount,
    coverageGaps: boundedCount,
    estimatedTokens: boundedCount,
    followUpGraphOperations: boundedCount,
    followUpOperations: boundedCount,
    followUpRecallOperations: boundedCount,
    requestedCodeAnchors: boundedCount,
    resolvedCodeAnchors: boundedCount,
    successful: boundedCount,
    timeToFirstSuccessfulMilliseconds: Schema.optionalKey(boundedDuration),
  }),
  feedback: Schema.Struct({
    applied: Schema.optionalKey(boundedCount),
    appliedRate: Schema.optionalKey(rate),
    dismiss: boundedCount,
    dismissRate: rate,
    pin: boundedCount,
    pinRate: rate,
    total: boundedCount,
    useful: boundedCount,
    usefulRate: rate,
    wrong: boundedCount,
    wrongRate: rate,
  }),
  health: Schema.Struct({
    opened: boundedCount,
    resolved: boundedCount,
  }),
  knowledgeDelta: Schema.Struct({
    approved: boundedCount,
    deferred: boundedCount,
    edited: boundedCount,
    proposed: boundedCount,
    rejected: boundedCount,
  }),
  period: Schema.Struct({
    from: isoInstant,
    to: isoInstant,
  }),
  scope: Schema.Literal('local'),
  setup: Schema.Struct({
    availability: Schema.Literals(['available', 'unavailable']),
    completed: boundedCount,
    failed: boundedCount,
    started: boundedCount,
    supportedAgentReuse: boundedCount,
    timeToFirstEvidenceMilliseconds: Schema.optionalKey(boundedDuration),
  }),
  type: Schema.Literal('value-report'),
  version: Schema.Literal(VALUE_REPORT_VERSION),
});

const STRICT_PARSE_OPTIONS = {errors: 'all', onExcessProperty: 'error'} as const;

export function parseValueReportV1(value: unknown): ValueReportV1 {
  const decoded = Schema.decodeUnknownSync(ValueReportV1Schema, STRICT_PARSE_OPTIONS)(value);
  if ((decoded.feedback.applied === undefined) !== (decoded.feedback.appliedRate === undefined)) {
    throw new Error('Value report applied feedback count and rate must be provided together.');
  }
  const report: ValueReportV1 = {
    ...decoded,
    feedback: {
      ...decoded.feedback,
      applied: decoded.feedback.applied ?? 0,
      appliedRate: decoded.feedback.appliedRate ?? 0,
    },
  };
  if (report.period.from > report.period.to) throw new Error('Value report period must be ordered.');
  if (report.contextBrief.resolvedCodeAnchors > report.contextBrief.requestedCodeAnchors) {
    throw new Error('Value report resolved anchors cannot exceed requested anchors.');
  }
  if (report.contextBrief.successful > report.contextBrief.attempts) {
    throw new Error('Value report successful briefs cannot exceed attempts.');
  }
  return report;
}

export function aggregateValueReportV1(input: ValueReportInputV1): ValueReportV1 {
  const period = normalizedPeriod(input.period);
  const from = new Date(period.from);
  const to = new Date(period.to);
  const feedback = summarizeRecallFeedback(input.feedbackEvents ?? [], {from, project: input.project, to});
  const applied = boundedInputCount(feedback.applied);
  const dismiss = boundedInputCount(feedback.dismiss);
  const pin = boundedInputCount(feedback.pin);
  const useful = boundedInputCount(feedback.useful);
  const wrong = boundedInputCount(feedback.wrong);
  const feedbackTotal = sumCounts(applied, dismiss, pin, useful, wrong);
  const contextBrief = aggregateContextBrief(input.counts?.contextBrief);
  return {
    contextBrief,
    feedback: {
      applied,
      appliedRate: ratio(applied, feedbackTotal),
      dismiss,
      dismissRate: ratio(dismiss, feedbackTotal),
      pin,
      pinRate: ratio(pin, feedbackTotal),
      total: feedbackTotal,
      useful,
      usefulRate: ratio(useful, feedbackTotal),
      wrong,
      wrongRate: ratio(wrong, feedbackTotal),
    },
    health: aggregateHealth(input.counts?.health),
    knowledgeDelta: aggregateKnowledgeDelta(input.counts?.knowledgeDelta),
    period,
    scope: 'local',
    setup: aggregateSetup(input.counts?.setup),
    type: 'value-report',
    version: VALUE_REPORT_VERSION,
  };
}

/** Alias kept short for callers building a local report without the schema suffix. */
export const aggregateValueReport = aggregateValueReportV1;

function aggregateContextBrief(input: ValueReportContextBriefInputV1 | undefined): ValueReportContextBriefV1 {
  const source = input ?? {};
  const samples = boundedTimingSamples(
    source.timeToFirstSuccessfulMillisecondsSamples ??
      (source.timeToFirstSuccessfulMilliseconds === undefined ? [] : [source.timeToFirstSuccessfulMilliseconds]),
  );
  const median = samples.length === 0 ? undefined : medianOf(samples);
  const attempts = boundedInputCount(source.attempts);
  const requestedCodeAnchors = boundedInputCount(source.requestedCodeAnchors);
  const graph = boundedInputCount(source.followUpGraphOperations);
  const recall = boundedInputCount(source.followUpRecallOperations);
  return {
    attempts,
    coverageGaps: boundedInputCount(source.coverageGaps),
    estimatedTokens: boundedInputCount(source.estimatedTokens),
    followUpGraphOperations: graph,
    followUpOperations: sumCounts(graph, recall),
    followUpRecallOperations: recall,
    requestedCodeAnchors,
    resolvedCodeAnchors: Math.min(requestedCodeAnchors, boundedInputCount(source.resolvedCodeAnchors)),
    successful: Math.min(attempts, boundedInputCount(source.successful)),
    ...(median === undefined ? {} : {timeToFirstSuccessfulMilliseconds: median}),
  };
}

function aggregateKnowledgeDelta(input: Partial<ValueReportKnowledgeDeltaV1> | undefined): ValueReportKnowledgeDeltaV1 {
  return {
    approved: boundedInputCount(input?.approved),
    deferred: boundedInputCount(input?.deferred),
    edited: boundedInputCount(input?.edited),
    proposed: boundedInputCount(input?.proposed),
    rejected: boundedInputCount(input?.rejected),
  };
}

function aggregateHealth(input: Partial<ValueReportHealthV1> | undefined): ValueReportHealthV1 {
  return {opened: boundedInputCount(input?.opened), resolved: boundedInputCount(input?.resolved)};
}

function aggregateSetup(input: ValueReportSetupInputV1 | undefined): ValueReportSetupV1 {
  const samples = boundedTimingSamples(
    input?.timeToFirstEvidenceMillisecondsSamples ??
      (input?.timeToFirstEvidenceMilliseconds === undefined ? [] : [input.timeToFirstEvidenceMilliseconds]),
  );
  const median = samples.length === 0 ? undefined : medianOf(samples);
  return {
    availability: input === undefined ? 'unavailable' : 'available',
    completed: boundedInputCount(input?.completed),
    failed: boundedInputCount(input?.failed),
    started: boundedInputCount(input?.started),
    supportedAgentReuse: boundedInputCount(input?.supportedAgentReuse),
    ...(median === undefined ? {} : {timeToFirstEvidenceMilliseconds: median}),
  };
}

function normalizedPeriod(period: ValueReportPeriodV1): ValueReportPeriodV1 {
  const from = parseInstant(period.from, 'from');
  const to = parseInstant(period.to, 'to');
  if (from > to) throw new RangeError('Value report period must be ordered.');
  return {from: new Date(from).toISOString(), to: new Date(to).toISOString()};
}

function parseInstant(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`Value report ${name} must be a valid instant.`);
  return parsed;
}

function boundedInputCount(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(VALUE_REPORT_MAX_COUNT, value);
}

function isDuration(value: number): value is number {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Keep the lowest bounded sample set so input order cannot affect the median. */
function boundedTimingSamples(values: readonly number[]): readonly number[] {
  const retained: number[] = [];
  for (const value of values) {
    if (!isDuration(value)) continue;
    const bounded = Math.min(VALUE_REPORT_MAX_DURATION_MILLISECONDS, value);
    if (retained.length < VALUE_REPORT_MAX_TIMING_SAMPLES) {
      retained.push(bounded);
      retained.sort((a, b) => a - b);
      continue;
    }
    const last = retained[retained.length - 1];
    if (bounded >= last) continue;
    retained[retained.length - 1] = bounded;
    retained.sort((a, b) => a - b);
  }
  return retained;
}

function medianOf(values: readonly number[]): number {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? Math.round((values[middle - 1] + values[middle]) / 2) : values[middle];
}

function sumCounts(...values: readonly number[]): number {
  return Math.min(
    VALUE_REPORT_MAX_COUNT,
    EffectArray.reduce(values, 0, (total, value) => total + value),
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}
