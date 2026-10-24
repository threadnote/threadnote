import {DateTime, Effect, Path, Schema} from 'effect';
import {writeFinalCliOutput} from '../effect/cli/output.js';
import {sha256Hex} from '@threadnote/platform/digest';
import {listCandidateReviews} from '@threadnote/memory/candidate';
import {readRecallFeedbackEvents} from '@threadnote/recall/feedback';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {buildValueReportExportV1, serializeValueReportExportV1, type ValueReportExportV1} from './export.js';
import {aggregateValueReportV1, type ValueReportV1} from './index.js';
import {readLocalValueEvents, summarizeCandidateReviewValue, summarizeLocalValueEvents} from './events.js';
import {deleteValueReportData, pruneValueReportData, VALUE_REPORT_EXPORT_DIRECTORY} from './storage.js';
import {ValueArtifactError, writeValueArtifact} from './artifact.js';
import {ManagerConsumerClockHints, nextManagerWindowChange} from '../manager/live_consumer_sources.js';

export const DEFAULT_VALUE_REPORT_PERIOD_DAYS = 30 as const;
export const DEFAULT_VALUE_REPORT_RETENTION_DAYS = 365 as const;
export const MAXIMUM_VALUE_REPORT_RETENTION_DAYS = 3_650 as const;
export {VALUE_REPORT_EXPORT_DIRECTORY} from './storage.js';

export class ValueReportCommandError extends Schema.TaggedError<ValueReportCommandError>()('ValueReportCommandError', {
  message: Schema.String,
}) {}

export interface RunValueReportOptionsV1 {
  readonly json?: boolean;
  readonly period?: number;
  readonly project?: string;
}

export interface RunValueReportExportOptionsV1 {
  readonly from?: string;
  readonly to?: string;
  readonly apply?: boolean;
  readonly period?: number;
  readonly project?: string;
}

export interface RunValueReportRetentionOptionsV1 {
  readonly apply?: boolean;
  readonly days?: number;
}

export interface RunValueReportDeleteOptionsV1 {
  readonly all?: boolean;
  readonly apply?: boolean;
  readonly events?: boolean;
  readonly exports?: boolean;
  readonly feedback?: boolean;
}

export const runValueReport = Effect.fn('valueReport.command')(function* (
  config: RuntimeConfig,
  options: RunValueReportOptionsV1,
) {
  const report = yield* buildLocalValueReport(config, options);
  yield* writeFinalCliOutput(options.json ? JSON.stringify(report) : renderValueReport(report));
});

export const runValueReportExport = Effect.fn('valueReport.export.command')(function* (
  config: RuntimeConfig,
  options: RunValueReportExportOptionsV1,
) {
  const report = yield* buildLocalValueReport(config, options);
  const bundle = buildValueReportExportV1(report);
  const serialized = serializeValueReportExportV1(bundle);
  if (options.apply !== true) {
    yield* writeFinalCliOutput(serialized);
    return;
  }
  const outputPath = yield* writeValueReportExport(config.agentContextHome, bundle);
  yield* writeFinalCliOutput(`Exported redacted ValueReportExportV1 to ${outputPath}.`);
});

export const runValueReportRetention = Effect.fn('valueReport.retention.command')(function* (
  config: RuntimeConfig,
  options: RunValueReportRetentionOptionsV1,
) {
  const retentionDays = options.days ?? DEFAULT_VALUE_REPORT_RETENTION_DAYS;
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > MAXIMUM_VALUE_REPORT_RETENTION_DAYS
  ) {
    return yield* ValueReportCommandError.make({
      message: `Value report retention days must be a whole number from 1 to ${MAXIMUM_VALUE_REPORT_RETENTION_DAYS}.`,
    });
  }
  const now = DateTime.toDateUtc(yield* DateTime.now);
  const receipt = yield* pruneValueReportData(config.agentContextHome, {
    apply: options.apply === true,
    now,
    retentionDays,
  });
  yield* writeFinalCliOutput(JSON.stringify(receipt));
});

export const runValueReportDelete = Effect.fn('valueReport.delete.command')(function* (
  config: RuntimeConfig,
  options: RunValueReportDeleteOptionsV1,
) {
  const all = options.all === true;
  const selection = {
    exports: all || options.exports === true,
    feedback: all || options.feedback === true,
    valueEvents: all || options.events === true,
  };
  if (!selection.feedback && !selection.valueEvents && !selection.exports) {
    return yield* ValueReportCommandError.make({
      message: 'Select --feedback, --events, --exports, or --all before previewing value-data deletion.',
    });
  }
  const receipt = yield* deleteValueReportData(config.agentContextHome, {
    apply: options.apply === true,
    ...selection,
  });
  yield* writeFinalCliOutput(JSON.stringify(receipt));
});

export const valueReportExportPath = Effect.fn('valueReport.export.path')(function* (
  agentContextHome: string,
  serialized: string,
) {
  const path = yield* Path.Path;
  const digest = yield* sha256Hex(serialized);
  return path.join(
    agentContextHome,
    ...VALUE_REPORT_EXPORT_DIRECTORY.split('/'),
    `threadnote-value-report-export-v1-${digest.slice(0, 24)}.json`,
  );
});

export const writeValueReportExport = Effect.fn('valueReport.export.write')(function* (
  agentContextHome: string,
  bundle: ValueReportExportV1,
) {
  const serialized = `${serializeValueReportExportV1(bundle)}\n`;
  return yield* writeValueArtifact(agentContextHome, serialized, 'threadnote-value-report-export-v1').pipe(
    Effect.catchIf(Schema.is(ValueArtifactError), () =>
      ValueReportCommandError.make({
        message: 'Refusing to replace a value-report export whose content does not match its digest path.',
      }),
    ),
  );
});

export const buildLocalValueReport = Effect.fn('valueReport.buildLocal')(function* (
  config: RuntimeConfig,
  options: Pick<RunValueReportExportOptionsV1, 'period' | 'project' | 'from' | 'to'>,
) {
  const periodDays = options.period ?? DEFAULT_VALUE_REPORT_PERIOD_DAYS;
  if (!Number.isSafeInteger(periodDays) || periodDays < 1) {
    return yield* ValueReportCommandError.make({
      message: 'Value report --period must be a positive whole number of days.',
    });
  }
  const now = yield* DateTime.now;
  const absolute = options.from !== undefined || options.to !== undefined;
  const window = absolute ? yield* absoluteWindow(options) : undefined;
  const [feedbackEvents, valueEvents, candidateReviews] = yield* Effect.all(
    [
      readRecallFeedbackEvents(config.agentContextHome),
      readLocalValueEvents(config.agentContextHome),
      listCandidateReviews(config.agentContextHome),
    ],
    {concurrency: 3},
  );
  const project = options.project?.trim();
  if (!absolute && periodDays === 30 && project) {
    // Reuse the inputs already loaded by the authoritative projection. Observers never rebuild this report.
    const timestamps = [
      ...feedbackEvents.map(event => Date.parse(event.timestamp)),
      ...valueEvents.map(event => Date.parse(event.timestamp)),
      ...candidateReviews.flatMap(review => [
        Date.parse(review.createdAt),
        ...review.auditEvents.map(event => Date.parse(event.at)),
      ]),
    ];
    yield* (yield* ManagerConsumerClockHints).register(
      'home',
      project,
      nextManagerWindowChange(DateTime.toEpochMillis(now), periodDays * 86_400_000, timestamps),
    );
  }
  const from = window?.from ?? DateTime.toEpochMillis(now) - periodDays * 86_400_000;
  const to = window?.to ?? DateTime.toEpochMillis(now);
  const period = {from: DateTime.formatIso(DateTime.makeUnsafe(from)), to: DateTime.formatIso(DateTime.makeUnsafe(to))};
  const range = {
    from: DateTime.toDateUtc(DateTime.makeUnsafe(from)),
    ...(project ? {project} : {}),
    to: DateTime.toDateUtc(DateTime.makeUnsafe(absolute ? to - 1 : to)),
  };
  const eventCounts = summarizeLocalValueEvents(valueEvents, range);
  const report = aggregateValueReportV1({
    counts: {
      ...eventCounts,
      knowledgeDelta: summarizeCandidateReviewValue(candidateReviews, range),
    },
    feedbackEvents: absolute ? feedbackEvents.filter(event => Date.parse(event.timestamp) < to) : feedbackEvents,
    period,
    ...(project ? {project} : {}),
  });
  return report;
});

function renderValueReport(report: ValueReportV1): string {
  return [
    `Local value report (${report.period.from} to ${report.period.to})`,
    `Feedback: ${report.feedback.total} total; ${report.feedback.applied} applied, ${report.feedback.useful} useful, ${report.feedback.pin} pinned, ${report.feedback.wrong} wrong, ${report.feedback.dismiss} dismissed.`,
    `Context briefs: ${report.contextBrief.successful}/${report.contextBrief.attempts} successful; ${report.contextBrief.coverageGaps} coverage gap(s).`,
    `Activation: ${report.setup.availability}; ${report.setup.completed} completed, ${report.setup.supportedAgentReuse} second-agent reuse${report.setup.timeToFirstEvidenceMilliseconds === undefined ? '' : `, ${report.setup.timeToFirstEvidenceMilliseconds} ms to first evidence`}.`,
    `Knowledge Delta: ${report.knowledgeDelta.proposed} proposed, ${report.knowledgeDelta.approved} approved, ${report.knowledgeDelta.edited} edited, ${report.knowledgeDelta.rejected} rejected, ${report.knowledgeDelta.deferred} deferred.`,
    `Health: ${report.health.opened} opened, ${report.health.resolved} resolved.`,
  ].join('\n');
}

function absoluteWindow(options: Pick<RunValueReportExportOptionsV1, 'from' | 'to' | 'period'>) {
  return Effect.try({
    try: () => {
      const date = (value: string | undefined) => {
        if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error();
        const parsed = Date.parse(`${value}T00:00:00.000Z`);
        if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw new Error();
        return parsed;
      };
      const from = date(options.from);
      const to = date(options.to);
      if (options.period !== undefined || from >= to) throw new Error();
      return {from, to};
    },
    catch: () =>
      ValueReportCommandError.make({
        message: 'Absolute export windows require ordered --from and --to UTC dates (YYYY-MM-DD), without --period.',
      }),
  });
}
