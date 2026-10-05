import {Schema} from 'effect';
import {parseValueReportExportV1, ValueReportExportV1Schema} from '../export.js';

export const PILOT_RETENTION_DAYS = 28;
export const PILOT_MAX_INPUT_BYTES = 4 * 1024 * 1024;
export const PILOT_MEASURES = [
  'setupCompletion',
  'setupMilliseconds',
  'firstCorrectEvidenceMilliseconds',
  'firstCorrectEvidenceTokens',
  'firstCorrectEvidenceTurns',
  'freshnessCurrentRate',
  'staleDetectionRate',
  'staleResolutionRate',
  'falseCurrentRate',
  'recallWithoutEvidenceRate',
  'fallbackRate',
  'setupFailureRate',
  'conflictRate',
  'dataLossRate',
  'silentPublicationRate',
] as const;
export const PILOT_DERIVED = [
  'firstSourceVerifiedBrief',
  'secondActorReuseWithinSevenDays',
  'approvedDeltaReuse',
] as const;
export const PILOT_METRICS = [...PILOT_MEASURES, ...PILOT_DERIVED] as const;
export type PilotMetric = (typeof PILOT_METRICS)[number];
export const PILOT_COUNTS = ['0', '1-2', '3-4', '5-9', '10-24', '25-49', '50-99', '100+'] as const;
export const PILOT_RATES = ['0', '1-24%', '25-49%', '50-74%', '75-99%', '100%', 'suppressed'] as const;
export const PILOT_VALUES = ['zero', 'low', 'medium', 'high', 'suppressed'] as const;
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10_000));
const actor = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(99));
const day = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u),
  Schema.makeFilter(value => {
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  }),
);
const states = ['observed', 'missing', 'inapplicable', 'pending', 'failed'] as const;

export const PilotInputSchema = Schema.Struct({
  schema: Schema.Literal('threadnote.value-pilot-input.v1'),
  version: Schema.Literal(1),
  windowStart: day,
  elapsedDays: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(28)),
  actors: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100)),
  evidenceCoverage: Schema.Literals(['complete', 'partial', 'unavailable']),
  sources: Schema.Array(Schema.Struct({actor, value: ValueReportExportV1Schema})).check(Schema.isMaxLength(100)),
  observations: Schema.Array(
    Schema.Struct({
      actor,
      sample: count,
      metric: Schema.Literals(PILOT_MEASURES),
      state: Schema.Literals(states),
      value: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(604_800_000)),
      ),
    }),
  ).check(Schema.isMaxLength(10_000)),
  evidence: Schema.Array(
    Schema.Struct({
      actor,
      item: count,
      minute: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(40_319)),
      kind: Schema.Literals(['verified-brief', 'approved-delta', 'verified-reuse', 'full-loop']),
    }),
  ).check(Schema.isMaxLength(10_000)),
});
export type PilotInput = typeof PilotInputSchema.Type;
export type PilotObservation = (typeof PilotInputSchema.Type.observations)[number];
export type PilotEvidence = (typeof PilotInputSchema.Type.evidence)[number];

export const PilotMetricSummarySchema = Schema.Struct({
  state: Schema.Literals([...states, 'mixed']),
  observed: Schema.Literals(PILOT_COUNTS),
  missing: Schema.Literals(PILOT_COUNTS),
  pending: Schema.Literals(PILOT_COUNTS),
  failed: Schema.Literals(PILOT_COUNTS),
  inapplicable: Schema.Literals(PILOT_COUNTS),
  positive: Schema.Literals(PILOT_COUNTS),
  rate: Schema.NullOr(Schema.Literals(PILOT_RATES)),
  median: Schema.NullOr(Schema.Literals(PILOT_VALUES)),
});
export type PilotMetricSummary = typeof PilotMetricSummarySchema.Type;
export const PilotReportSchema = Schema.Struct({
  schema: Schema.Literal('threadnote.value-pilot-report.v1'),
  version: Schema.Literal(1),
  scope: Schema.Literal('single-deployment'),
  windowStart: day,
  elapsedDays: count,
  reportDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  actors: Schema.Literals(PILOT_COUNTS),
  evidenceCoverage: Schema.Literals(['complete', 'partial', 'unavailable']),
  metrics: Schema.Record(Schema.Literals(PILOT_METRICS), PilotMetricSummarySchema),
  supportingValue: Schema.Struct({
    sources: Schema.Literals(PILOT_COUNTS),
    missingSources: Schema.Literals(PILOT_COUNTS),
    successfulBriefs: Schema.Literals(PILOT_COUNTS),
    approvedDeltas: Schema.Literals(PILOT_COUNTS),
    setupCompleted: Schema.Literals(PILOT_COUNTS),
    healthOpened: Schema.Literals(PILOT_COUNTS),
    healthResolved: Schema.Literals(PILOT_COUNTS),
  }),
  weeks: Schema.Array(
    Schema.Struct({
      week: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(4)),
      state: Schema.Literals(['observed', 'missing', 'pending']),
      fullLoopActors: Schema.Literals(PILOT_COUNTS),
      crossActorFullLoopActors: Schema.NullOr(Schema.Literals(PILOT_COUNTS)),
      retainedFromPriorWeek: Schema.NullOr(Schema.Literals(PILOT_COUNTS)),
    }),
  ).check(Schema.isMinLength(4), Schema.isMaxLength(4)),
  fourWeekCrossActorRetention: Schema.Struct({
    state: Schema.Literals(['observed', 'missing', 'pending']),
    actors: Schema.Literals(PILOT_COUNTS),
  }),
  retention: Schema.Struct({
    days: Schema.Literal(28),
    correlation: Schema.Literal('memory-only'),
    managedExports: Schema.Literal('prune-on-export-or-explicit-retention'),
    externalCopies: Schema.Literal('caller-owned'),
  }),
  evidenceBasis: Schema.Literal('operator-supplied-observations'),
  pilotSuccess: Schema.Literal('not-assessed'),
});
export type PilotReport = typeof PilotReportSchema.Type;
export const PILOT_STRICT = {errors: 'all', onExcessProperty: 'error'} as const;

export function parsePilotInput(value: unknown): PilotInput {
  const input = Schema.decodeUnknownSync(PilotInputSchema, PILOT_STRICT)(value);
  const start = Date.parse(`${input.windowStart}T00:00:00.000Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== input.windowStart) invalid();
  const end = start + input.elapsedDays * 86_400_000;
  const seen = new Set<string>();
  if (input.evidenceCoverage === 'unavailable' && input.evidence.length > 0) invalid();
  for (const source of input.sources) {
    checkActor(source.actor, input.actors);
    unique(seen, `source:${source.actor}`);
    const report = parseValueReportExportV1(source.value).report;
    if (report.period.from !== new Date(start).toISOString() || report.period.to !== new Date(end).toISOString())
      invalid();
  }
  for (const observation of input.observations) {
    checkActor(observation.actor, input.actors);
    unique(seen, `observation:${observation.actor}:${observation.metric}:${observation.sample}`);
    if ((observation.state === 'observed') !== (observation.value !== undefined)) invalid();
    if (isBinaryMetric(observation.metric) && observation.value !== undefined && observation.value > 1) invalid();
    if (!observation.metric.endsWith('Rate') && observation.sample !== 0) invalid();
  }
  for (const event of input.evidence) {
    checkActor(event.actor, input.actors);
    unique(seen, `event:${event.actor}:${event.item}:${event.kind}`);
    if (event.minute >= input.elapsedDays * 1440) invalid();
  }
  return input;
}

export function isBinaryMetric(metric: PilotMetric): boolean {
  return !metric.endsWith('Milliseconds') && !metric.endsWith('Tokens') && !metric.endsWith('Turns');
}
function checkActor(slot: number, actors: number): void {
  if (slot >= actors) invalid();
}
function unique(seen: Set<string>, key: string): void {
  if (seen.has(key)) invalid();
  seen.add(key);
}
function invalid(): never {
  throw new Error('Invalid pilot input.');
}
