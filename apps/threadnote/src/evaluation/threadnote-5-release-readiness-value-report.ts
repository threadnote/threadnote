import {isOneOf as checkedIsOneOf} from '@threadnote/platform/validation';
import {Array as EffectArray, Option as EffectOption} from 'effect';
import {canonicalJson} from '@threadnote/graph/checkpoint/canonical_json';
import {activationReceiptRevisionV1, parseActivationPlanV1, parseActivationReceiptV1} from '../activation/contract.js';
import {activationValueEventsV1} from '../activation/value.js';
import {RECALL_FEEDBACK_ACTIONS, type RecallFeedbackEvent} from '@threadnote/recall/feedback';
import {summarizeLocalValueEvents, type LocalValueEventV1} from '../value_report/events.js';
import {
  aggregateValueReportV1,
  type ValueReportContextBriefInputV1,
  type ValueReportCountsInputV1,
  type ValueReportHealthV1,
  type ValueReportInputV1,
  type ValueReportKnowledgeDeltaV1,
  type ValueReportSetupInputV1,
  type ValueReportV1,
} from '../value_report/index.js';
import {
  threadnote5RecallFeedbackEventDigest,
  threadnote5ValueReportOfflineObservationDigest,
  type Threadnote5LocalAuthorityEntryV1,
} from './threadnote-5-release-readiness-authority.js';
import {
  type Threadnote5MeasurementV1,
  type Threadnote5ReleaseScenario,
} from './threadnote-5-release-readiness-contract.js';
import {
  allowedKeys,
  boundedArray,
  compareText,
  exactObject,
  hash,
  hashText,
  integerIn,
  isoInstant,
  nonEmptyText,
  object,
  text,
  unique,
} from './threadnote-5-release-readiness-validation.js';
import * as EffectRecord from 'effect/Record';

const MAX_ATTEMPTS = 64;

export interface Threadnote5ActivationValueLinkV1 {
  readonly activationId: string;
  readonly finalReceiptRevision: string;
}

export interface Threadnote5FeedbackTrialLinkV1 {
  readonly action: RecallFeedbackEvent['action'];
  readonly feedbackEventDigest: string;
  readonly laneId: string;
  readonly offlineObservationDigest: string | null;
  readonly offlineVerified: boolean;
}

export interface Threadnote5ValueReportDerivedClaimsV1 {
  readonly assertions: readonly string[];
  readonly correlations?: {
    readonly activationValues?: readonly Threadnote5ActivationValueLinkV1[];
    readonly feedbackTrials: readonly Threadnote5FeedbackTrialLinkV1[];
  };
  readonly measurements: readonly Threadnote5MeasurementV1[];
  readonly missingKinds?: readonly string[];
}

export function deriveThreadnote5ValueReportClaims(
  scenario: Threadnote5ReleaseScenario,
  value: unknown,
  authority: Threadnote5LocalAuthorityEntryV1 | undefined,
): Threadnote5ValueReportDerivedClaimsV1 {
  const source = object(value, 'value-report artifact');
  if (
    !allowedKeys(source, ['activationTrials', 'captures', 'feedbackTrials']) ||
    !EffectArray.isArray(source.captures)
  ) {
    throw new Error('Value-report artifact has unsupported fields.');
  }
  const captures = EffectArray.map(
    boundedArray(source.captures, 'value-report captures', 1, MAX_ATTEMPTS),
    parseValueReportCapture,
  );
  if (!unique(EffectArray.map(captures, capture => `${capture.report.period.from}\0${capture.report.period.to}`))) {
    throw new Error('Value-report capture periods must be unique.');
  }
  const feedbackTrials = EffectArray.map(
    boundedArray(source.feedbackTrials, 'value-report feedback trials', 1, MAX_ATTEMPTS),
    item => parseFeedbackTrial(item, scenario),
  );
  if (
    !unique(EffectArray.map(feedbackTrials, trial => trial.feedbackEventDigest)) ||
    !unique(EffectArray.map(feedbackTrials, trial => trial.laneId))
  ) {
    throw new Error('Value-report feedback trials must be unique.');
  }
  const capturedEvents = EffectArray.flatMap(captures, capture => capture.feedbackEvents);
  if (
    canonicalJson(EffectArray.map(capturedEvents, threadnote5RecallFeedbackEventDigest).sort(compareText)) !==
    canonicalJson(EffectArray.map(feedbackTrials, trial => trial.feedbackEventDigest).sort(compareText))
  ) {
    throw new Error('Value-report feedback trials do not exactly cover the raw report events.');
  }
  const reports = EffectArray.map(captures, capture => capture.report);
  const eligibleWrong = feedbackTrials.length;
  const wrong = EffectArray.filter(feedbackTrials, trial => trial.action === 'wrong').length;
  assertFeedbackTrialsMatchReports(feedbackTrials, reports);
  const eligibleReuse = EffectArray.reduce(reports, 0, (sum, report) => sum + report.setup.started);
  const reuse = EffectArray.reduce(reports, 0, (sum, report) => sum + report.setup.supportedAgentReuse);
  if (EffectArray.some(reports, report => report.setup.supportedAgentReuse > report.setup.started)) {
    throw new Error('Value report reuse cannot exceed setup attempts.');
  }
  const activationLinks =
    source.activationTrials === undefined
      ? undefined
      : activationValueTrials(boundedArray(source.activationTrials, 'activation value trials', 1, MAX_ATTEMPTS));
  const measurements = valueReportMeasurements(scenario, eligibleWrong, wrong, eligibleReuse, reuse);
  if (authority === undefined) {
    return {assertions: [], measurements, missingKinds: ['value-report-trial-authority']};
  }
  if (authority.type !== 'value-report-verification') {
    throw new Error('Value Report authority type does not match its source record.');
  }
  const expectedAuthority = EffectArray.map(feedbackTrials, trial => ({
    feedbackEventDigest: trial.feedbackEventDigest,
    laneId: trial.laneId,
    offlineObservationDigest: trial.offlineObservationDigest,
  }));
  if (
    canonicalJson(authority.trials) !==
    canonicalJson(
      [...expectedAuthority].sort((left, right) => compareText(left.feedbackEventDigest, right.feedbackEventDigest)),
    )
  ) {
    throw new Error('Value Report authority does not match its raw feedback trials.');
  }
  return {
    assertions: [],
    correlations: {
      ...(activationLinks === undefined ? {} : {activationValues: activationLinks}),
      feedbackTrials,
    },
    measurements,
    ...(scenario === 'two-agent' && activationLinks === undefined
      ? {missingKinds: ['activation', 'activation-value-linkage']}
      : {}),
  };
}

function assertFeedbackTrialsMatchReports(
  feedbackTrials: readonly Threadnote5FeedbackTrialLinkV1[],
  reports: readonly ValueReportV1[],
): void {
  const expected = {
    applied: EffectArray.filter(feedbackTrials, trial => trial.action === 'applied').length,
    dismiss: EffectArray.filter(feedbackTrials, trial => trial.action === 'dismiss').length,
    pin: EffectArray.filter(feedbackTrials, trial => trial.action === 'pin').length,
    total: feedbackTrials.length,
    useful: EffectArray.filter(feedbackTrials, trial => trial.action === 'useful').length,
    wrong: EffectArray.filter(feedbackTrials, trial => trial.action === 'wrong').length,
  };
  const actual = EffectArray.reduce(
    reports,
    {applied: 0, dismiss: 0, pin: 0, total: 0, useful: 0, wrong: 0},
    (counts, report) => ({
      applied: counts.applied + report.feedback.applied,
      dismiss: counts.dismiss + report.feedback.dismiss,
      pin: counts.pin + report.feedback.pin,
      total: counts.total + report.feedback.total,
      useful: counts.useful + report.feedback.useful,
      wrong: counts.wrong + report.feedback.wrong,
    }),
  );
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error('Value-report feedback trials are filtered by report period or project scope.');
  }
}

function valueReportMeasurements(
  scenario: Threadnote5ReleaseScenario,
  eligibleWrong: number,
  wrong: number,
  eligibleReuse: number,
  reuse: number,
): readonly Threadnote5MeasurementV1[] {
  return [
    {eligibleCount: eligibleWrong, id: 'wrong-memory-rate', positiveCount: wrong},
    ...(scenario === 'two-agent'
      ? [{eligibleCount: eligibleReuse, id: 'second-agent-reuse-rate' as const, positiveCount: reuse}]
      : []),
  ];
}

function parseFeedbackTrial(value: unknown, scenario: Threadnote5ReleaseScenario): Threadnote5FeedbackTrialLinkV1 {
  const trial = exactObject(value, ['event', 'laneId', 'offlineObservation'], 'value-report feedback trial');
  const event = parseRecallFeedbackEvent(trial.event);
  const offlineObservation =
    trial.offlineObservation === null
      ? null
      : exactObject(
          trial.offlineObservation,
          ['afterAttemptCount', 'beforeAttemptCount'],
          'Value Report offline observation',
        );
  if (
    (scenario === 'offline') !== (offlineObservation !== null) ||
    (offlineObservation !== null &&
      (offlineObservation.beforeAttemptCount !== 0 || offlineObservation.afterAttemptCount !== 0))
  ) {
    throw new Error('Value Report offline trial requires an independently observed zero-network boundary.');
  }
  return {
    action: event.action,
    feedbackEventDigest: threadnote5RecallFeedbackEventDigest(event),
    laneId: hashText(trial.laneId, 'Value Report lane ID'),
    offlineObservationDigest:
      offlineObservation === null ? null : threadnote5ValueReportOfflineObservationDigest(offlineObservation),
    offlineVerified: offlineObservation !== null,
  };
}

function activationValueTrials(trials: readonly unknown[]): readonly Threadnote5ActivationValueLinkV1[] {
  const links: Threadnote5ActivationValueLinkV1[] = [];
  for (const value of trials) {
    const trial = exactObject(value, ['events', 'input', 'report', 'state'], 'activation value trial');
    const state = exactObject(trial.state, ['plan', 'receipt'], 'activation value state');
    const plan = parseActivationPlanV1(state.plan);
    const receipt = parseActivationReceiptV1(state.receipt);
    if (
      receipt.activationId !== plan.activationId ||
      receipt.planHash !== plan.planHash ||
      activationReceiptRevisionV1(receipt) !== receipt.revision
    ) {
      throw new Error('Activation value trial state does not match its plan.');
    }
    if (!EffectArray.isArray(trial.events)) throw new Error('Activation value trial events are invalid.');
    const events = EffectArray.map(trial.events, parseLocalValueEvent);
    const expected = activationValueEventsV1(receipt);
    if (
      events.length !== expected.length ||
      !unique(EffectArray.map(events, event => event.eventId)) ||
      !unique(EffectArray.map(expected, event => event.eventId))
    ) {
      throw new Error('Activation value trial events are incomplete or duplicated.');
    }
    for (const event of expected) {
      const actual = EffectOption.getOrUndefined(
        EffectArray.findFirst(
          events,
          candidate => candidate.kind === 'activation' && candidate.eventId === event.eventId,
        ),
      );
      if (canonicalJson(actual) !== canonicalJson(event)) {
        throw new Error('Activation value trial event does not match the production projection.');
      }
    }
    const input = object(trial.input, 'activation value report input');
    const report = aggregateValueReportV1({
      ...parseValueReportInput(input),
      counts: summarizeLocalValueEvents(events, {
        from: new Date(text(object(input.period, 'activation value period').from, 'activation value period from', 64)),
        to: new Date(text(object(input.period, 'activation value period').to, 'activation value period to', 64)),
      }),
    });
    if (canonicalJson(report) !== canonicalJson(trial.report)) {
      throw new Error('Activation value trial report does not match its raw events.');
    }
    links.push({activationId: plan.activationId, finalReceiptRevision: receipt.revision});
  }
  if (!unique(EffectArray.map(links, link => link.activationId)))
    throw new Error('Activation value trials must be unique.');
  return links;
}

function parseLocalValueEvent(value: unknown): Extract<LocalValueEventV1, {readonly kind: 'activation'}> {
  const event = object(value, 'local value event');
  if (
    event.kind !== 'activation' ||
    event.version !== 1 ||
    !hash(event.eventId) ||
    !integerIn(event.durationMilliseconds, 0, 7 * 24 * 60 * 60 * 1_000) ||
    !isoInstant(event.timestamp) ||
    !checkedIsOneOf(['started', 'first-evidence', 'completed', 'second-surface-proof'], event.phase) ||
    !allowedKeys(event, ['durationMilliseconds', 'eventId', 'kind', 'phase', 'timestamp', 'version'])
  ) {
    throw new Error('Activation value event is invalid.');
  }
  return {
    durationMilliseconds: event.durationMilliseconds,
    eventId: event.eventId,
    kind: 'activation',
    phase: event.phase,
    timestamp: event.timestamp,
    version: 1,
  };
}

function parseValueReportCapture(value: unknown): {
  readonly feedbackEvents: readonly RecallFeedbackEvent[];
  readonly report: ValueReportV1;
} {
  const capture = exactObject(value, ['input', 'report'], 'value-report capture');
  const input = parseValueReportInput(capture.input);
  const feedbackEvents = input.feedbackEvents ?? [];
  const rebuilt = aggregateValueReportV1({...input, feedbackEvents});
  if (canonicalJson(rebuilt) !== canonicalJson(capture.report)) {
    throw new Error('Value report does not match its source events and counts.');
  }
  return {feedbackEvents, report: rebuilt};
}

function parseValueReportInput(value: unknown): ValueReportInputV1 {
  const input = object(value, 'value report input');
  const period = object(input.period, 'value report input period');
  const feedbackEvents =
    input.feedbackEvents === undefined
      ? undefined
      : EffectArray.isArray(input.feedbackEvents)
        ? EffectArray.map(input.feedbackEvents, parseRecallFeedbackEvent)
        : (() => {
            throw new Error('Value report feedback events must be an array.');
          })();
  const project = input.project;
  if (project !== undefined && typeof project !== 'string')
    throw new Error('Value report project must be a string when present.');
  const counts = parseValueReportCounts(input.counts);
  return {
    period: {
      from: text(period.from, 'value report period from', 64),
      to: text(period.to, 'value report period to', 64),
    },
    ...(feedbackEvents === undefined ? {} : {feedbackEvents}),
    ...(project === undefined ? {} : {project}),
    ...(counts === undefined ? {} : {counts}),
  };
}

function parseValueReportCounts(value: unknown): ValueReportCountsInputV1 | undefined {
  if (value === undefined) return undefined;
  const counts = object(value, 'value report counts');
  const rawContextBrief =
    counts.contextBrief === undefined ? undefined : object(counts.contextBrief, 'value report context brief counts');
  const contextBrief: ValueReportContextBriefInputV1 | undefined =
    rawContextBrief === undefined
      ? undefined
      : {
          attempts: optionalNumberField(rawContextBrief, 'attempts', 'value report context brief counts'),
          successful: optionalNumberField(rawContextBrief, 'successful', 'value report context brief counts'),
          requestedCodeAnchors: optionalNumberField(
            rawContextBrief,
            'requestedCodeAnchors',
            'value report context brief counts',
          ),
          resolvedCodeAnchors: optionalNumberField(
            rawContextBrief,
            'resolvedCodeAnchors',
            'value report context brief counts',
          ),
          coverageGaps: optionalNumberField(rawContextBrief, 'coverageGaps', 'value report context brief counts'),
          estimatedTokens: optionalNumberField(rawContextBrief, 'estimatedTokens', 'value report context brief counts'),
          followUpGraphOperations: optionalNumberField(
            rawContextBrief,
            'followUpGraphOperations',
            'value report context brief counts',
          ),
          followUpRecallOperations: optionalNumberField(
            rawContextBrief,
            'followUpRecallOperations',
            'value report context brief counts',
          ),
          timeToFirstSuccessfulMilliseconds: optionalNumberField(
            rawContextBrief,
            'timeToFirstSuccessfulMilliseconds',
            'value report context brief counts',
          ),
        };
  const contextBriefSamples =
    rawContextBrief === undefined
      ? undefined
      : parseOptionalNumberSamples(
          rawContextBrief.timeToFirstSuccessfulMillisecondsSamples,
          'value report context brief samples',
        );
  const contextBriefInput =
    contextBrief === undefined
      ? undefined
      : {
          ...contextBrief,
          ...(contextBriefSamples === undefined ? {} : {timeToFirstSuccessfulMillisecondsSamples: contextBriefSamples}),
        };
  const rawKnowledgeDelta =
    counts.knowledgeDelta === undefined
      ? undefined
      : object(counts.knowledgeDelta, 'value report knowledge delta counts');
  const knowledgeDelta: Partial<ValueReportKnowledgeDeltaV1> | undefined =
    rawKnowledgeDelta === undefined
      ? undefined
      : {
          proposed: optionalNumberField(rawKnowledgeDelta, 'proposed', 'value report knowledge delta counts'),
          approved: optionalNumberField(rawKnowledgeDelta, 'approved', 'value report knowledge delta counts'),
          edited: optionalNumberField(rawKnowledgeDelta, 'edited', 'value report knowledge delta counts'),
          rejected: optionalNumberField(rawKnowledgeDelta, 'rejected', 'value report knowledge delta counts'),
          deferred: optionalNumberField(rawKnowledgeDelta, 'deferred', 'value report knowledge delta counts'),
        };
  const rawHealth = counts.health === undefined ? undefined : object(counts.health, 'value report health counts');
  const health: Partial<ValueReportHealthV1> | undefined =
    rawHealth === undefined
      ? undefined
      : {
          opened: optionalNumberField(rawHealth, 'opened', 'value report health counts'),
          resolved: optionalNumberField(rawHealth, 'resolved', 'value report health counts'),
        };
  const rawSetup = counts.setup === undefined ? undefined : object(counts.setup, 'value report setup counts');
  const setupNumbers: ValueReportSetupInputV1 | undefined =
    rawSetup === undefined
      ? undefined
      : {
          completed: optionalNumberField(rawSetup, 'completed', 'value report setup counts'),
          failed: optionalNumberField(rawSetup, 'failed', 'value report setup counts'),
          started: optionalNumberField(rawSetup, 'started', 'value report setup counts'),
          supportedAgentReuse: optionalNumberField(rawSetup, 'supportedAgentReuse', 'value report setup counts'),
          timeToFirstEvidenceMilliseconds: optionalNumberField(
            rawSetup,
            'timeToFirstEvidenceMilliseconds',
            'value report setup counts',
          ),
        };
  const setupSamples =
    rawSetup === undefined
      ? undefined
      : parseOptionalNumberSamples(rawSetup.timeToFirstEvidenceMillisecondsSamples, 'value report setup samples');
  const setup: ValueReportSetupInputV1 | undefined =
    setupNumbers === undefined
      ? undefined
      : {
          ...setupNumbers,
          ...(setupSamples === undefined ? {} : {timeToFirstEvidenceMillisecondsSamples: setupSamples}),
        };
  return {
    ...(contextBrief === undefined ? {} : {contextBrief: contextBriefInput}),
    ...(knowledgeDelta === undefined ? {} : {knowledgeDelta}),
    ...(health === undefined ? {} : {health}),
    ...(setup === undefined ? {} : {setup}),
  };
}

function optionalNumberField(source: Record<string, unknown>, key: string, label: string): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new Error(`${label} must contain numeric values.`);
  return value;
}

function parseOptionalNumberSamples(value: unknown, label: string): readonly number[] | undefined {
  if (value === undefined) return undefined;
  if (!EffectArray.isArray(value) || EffectArray.some(value, sample => typeof sample !== 'number'))
    throw new Error(`${label} must be a numeric array.`);
  const samples: number[] = [];
  for (const sample of value) {
    if (typeof sample !== 'number') throw new Error(`${label} must be a numeric array.`);
    samples.push(sample);
  }
  return samples;
}

function parseRecallFeedbackEvent(value: unknown): RecallFeedbackEvent {
  const event = object(value, 'recall feedback event');
  const project = event.project;
  const action = event.action;
  const queryFingerprint = event.queryFingerprint;
  const rankerVersion = event.rankerVersion;
  const timestamp = event.timestamp;
  const uri = event.uri;
  const keys =
    project === undefined
      ? ['action', 'queryFingerprint', 'rankerVersion', 'timestamp', 'uri', 'version']
      : ['action', 'project', 'queryFingerprint', 'rankerVersion', 'timestamp', 'uri', 'version'];
  if (
    canonicalJson(EffectRecord.keys(event).sort()) !== canonicalJson(keys.sort()) ||
    event.version !== 1 ||
    !checkedIsOneOf(RECALL_FEEDBACK_ACTIONS, action) ||
    !hash(queryFingerprint) ||
    !nonEmptyText(rankerVersion, 128) ||
    !isoInstant(timestamp) ||
    !nonEmptyText(uri, 2_048) ||
    (project !== undefined && !nonEmptyText(project, 256))
  ) {
    throw new Error('Recall feedback event is invalid.');
  }
  return {
    action,
    ...(project === undefined ? {} : {project}),
    queryFingerprint,
    rankerVersion,
    timestamp,
    uri,
    version: 1,
  };
}
