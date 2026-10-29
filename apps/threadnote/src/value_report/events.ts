import {
  isSafeInteger as checkedIsSafeInteger,
  isFiniteNumber as checkedIsFiniteNumber,
} from '@threadnote/platform/validation';
import {Array as EffectArray} from 'effect';
import {Crypto, Effect, FileSystem, Option, Path, Predicate, Schema} from 'effect';
import {withExclusiveFileLock} from '@threadnote/platform/file/lock';
import type {CandidateReview} from '@threadnote/memory/candidate';
import type {ValueReportCountsInputV1} from './index.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const VALUE_EVENT_VERSION = 1 as const;
const VALUE_EVENT_FILE = 'value-events-v1.jsonl';
export const VALUE_EVENT_MAXIMUM_EVENTS = 10_000 as const;
export const VALUE_EVENT_RETENTION_DAYS = 365 as const;
const MAX_VALUE_EVENTS = VALUE_EVENT_MAXIMUM_EVENTS;
const VALUE_EVENT_RETENTION_MILLISECONDS = VALUE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const LOCK_OPTIONS = {
  retryIntervalMilliseconds: 25,
  staleAfterMilliseconds: 5 * 60 * 1_000,
  waitTimeoutMilliseconds: 5_000,
} as const;

export interface ContextBriefValueEventV1 {
  readonly coverageGaps: number;
  readonly durationMilliseconds: number;
  readonly estimatedTokens: number;
  readonly kind: 'context-brief';
  readonly project?: string;
  readonly requestedCodeAnchors: number;
  readonly resolvedCodeAnchors: number;
  readonly successful: boolean;
  readonly timestamp: string;
  readonly version: typeof VALUE_EVENT_VERSION;
}

export type CodexResumePreloadOutcome =
  | 'already-preloaded'
  | 'disabled'
  | 'ineligible-evidence'
  | 'injected'
  | 'invalid-input'
  | 'lookup-unavailable'
  | 'manual-context'
  | 'over-limit';

export type CodexResumeContinuationEvidenceState = 'background' | 'evidence-bearing';

export interface CodexResumePreloadValueEventV1 {
  readonly continuationEvidenceState?: CodexResumeContinuationEvidenceState;
  readonly durationMilliseconds: number;
  readonly estimatedTokens: number;
  readonly evidenceState?: 'degraded' | 'no-match' | 'partial' | 'sufficient';
  readonly kind: 'codex-resume-preload';
  readonly outcome: CodexResumePreloadOutcome;
  readonly outputBytes: number;
  readonly timestamp: string;
  readonly version: typeof VALUE_EVENT_VERSION;
}

export interface HealthValueEventV1 {
  readonly activeFindings: number;
  readonly kind: 'health';
  readonly opened: number;
  readonly project: string;
  readonly resolved: number;
  readonly timestamp: string;
  readonly version: typeof VALUE_EVENT_VERSION;
}

export interface SetupCompletionValueEventV1 {
  readonly completed: 1;
  readonly kind: 'setup';
  readonly supportedAgentReuse: 0 | 1;
  readonly timestamp: string;
  readonly version: typeof VALUE_EVENT_VERSION;
}

export interface SetupLifecycleValueEventV1 {
  readonly durationMilliseconds: number;
  readonly kind: 'setup-lifecycle';
  readonly phase: 'started' | 'completed' | 'failed';
  readonly timeToFirstEvidenceMilliseconds?: number;
  readonly timestamp: string;
  readonly version: typeof VALUE_EVENT_VERSION;
}

export interface ActivationValueEventV1 {
  readonly durationMilliseconds: number;
  readonly eventId: string;
  readonly kind: 'activation';
  readonly phase: 'started' | 'first-evidence' | 'completed' | 'second-surface-proof';
  readonly timestamp: string;
  readonly version: typeof VALUE_EVENT_VERSION;
}

export type LocalValueEventV1 =
  | ActivationValueEventV1
  | CodexResumePreloadValueEventV1
  | ContextBriefValueEventV1
  | HealthValueEventV1
  | SetupCompletionValueEventV1
  | SetupLifecycleValueEventV1;

export const recordActivationValueEvent = Effect.fn('valueReport.recordActivation')(function* (
  agentContextHome: string,
  event: Omit<ActivationValueEventV1, 'kind' | 'version'>,
) {
  yield* appendValueEvent(agentContextHome, {
    ...event,
    durationMilliseconds: boundedDuration(event.durationMilliseconds),
    kind: 'activation',
    version: VALUE_EVENT_VERSION,
  });
});

export const recordContextBriefValueEvent = Effect.fn('valueReport.recordContextBrief')(function* (
  agentContextHome: string,
  event: Omit<ContextBriefValueEventV1, 'kind' | 'version'>,
) {
  yield* appendValueEvent(agentContextHome, {kind: 'context-brief', version: VALUE_EVENT_VERSION, ...event});
});

export const recordCodexResumePreloadValueEvent = Effect.fn('valueReport.recordCodexResumePreload')(function* (
  agentContextHome: string,
  event: Omit<CodexResumePreloadValueEventV1, 'kind' | 'version'>,
) {
  yield* appendValueEvent(agentContextHome, {
    ...event,
    durationMilliseconds: boundedDuration(event.durationMilliseconds),
    estimatedTokens: boundedCount(event.estimatedTokens),
    kind: 'codex-resume-preload',
    outputBytes: boundedCount(event.outputBytes),
    version: VALUE_EVENT_VERSION,
  });
});

export const recordHealthValueSnapshot = Effect.fn('valueReport.recordHealthSnapshot')(function* (
  agentContextHome: string,
  input: {readonly activeFindings: number; readonly project: string; readonly timestamp: string},
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = valueEventPath(pathService, agentContextHome);
  yield* withExclusiveFileLock(
    fs,
    `${path}.lock`,
    LOCK_OPTIONS,
    Effect.gen(function* () {
      const existing = yield* readValueEvents(fs, path);
      const previous = Option.getOrUndefined(
        EffectArray.findFirst(
          [...existing].reverse(),
          (event): event is HealthValueEventV1 => event.kind === 'health' && event.project === input.project,
        ),
      );
      const activeFindings = boundedCount(input.activeFindings);
      const previousActive = previous?.activeFindings ?? 0;
      const event: HealthValueEventV1 = {
        activeFindings,
        kind: 'health',
        opened: Math.max(0, activeFindings - previousActive),
        project: input.project,
        resolved: Math.max(0, previousActive - activeFindings),
        timestamp: input.timestamp,
        version: VALUE_EVENT_VERSION,
      };
      yield* writeValueEvents(fs, path, retainEvents([...existing, event], event.timestamp));
    }),
  );
});

export const recordSetupCompletionValueEvent = Effect.fn('valueReport.recordSetupCompletion')(function* (
  agentContextHome: string,
  input: {readonly supportedAgentReuse: boolean; readonly timestamp: string},
) {
  yield* appendValueEvent(agentContextHome, {
    completed: 1,
    kind: 'setup',
    supportedAgentReuse: input.supportedAgentReuse ? 1 : 0,
    timestamp: input.timestamp,
    version: VALUE_EVENT_VERSION,
  });
});

export const recordSetupLifecycleValueEvent = Effect.fn('valueReport.recordSetupLifecycle')(function* (
  agentContextHome: string,
  event: Omit<SetupLifecycleValueEventV1, 'kind' | 'version'>,
) {
  yield* appendValueEvent(agentContextHome, {
    durationMilliseconds: boundedDuration(event.durationMilliseconds),
    kind: 'setup-lifecycle',
    phase: event.phase,
    ...(event.timeToFirstEvidenceMilliseconds === undefined
      ? {}
      : {timeToFirstEvidenceMilliseconds: boundedDuration(event.timeToFirstEvidenceMilliseconds)}),
    timestamp: event.timestamp,
    version: VALUE_EVENT_VERSION,
  });
});

export const readLocalValueEvents = Effect.fn('valueReport.readEvents')(function* (agentContextHome: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  return yield* readValueEvents(fs, valueEventPath(pathService, agentContextHome));
});

export interface LocalValueEventStorageResultV1 {
  readonly after: number;
  readonly applied: boolean;
  readonly before: number;
  readonly removed: number;
}

export const pruneLocalValueEvents = Effect.fn('valueReport.pruneEvents')(function* (
  agentContextHome: string,
  input: {readonly apply: boolean; readonly now: Date; readonly retentionDays: number},
) {
  if (!checkedIsSafeInteger(input.retentionDays) || input.retentionDays < 1) {
    throw new RangeError('Value event retention days must be a positive whole number.');
  }
  const cutoff = input.now.getTime() - input.retentionDays * 86_400_000;
  return yield* mutateValueEvents(agentContextHome, input.apply, events =>
    EffectArray.filter(events, event => Date.parse(event.timestamp) >= cutoff),
  );
});

export const clearLocalValueEvents = Effect.fn('valueReport.clearEvents')(function* (
  agentContextHome: string,
  apply: boolean,
) {
  return yield* mutateValueEvents(agentContextHome, apply, () => []);
});

export function summarizeLocalValueEvents(
  events: readonly LocalValueEventV1[],
  options: {readonly from: Date; readonly project?: string; readonly to: Date},
): ValueReportCountsInputV1 {
  const contextBriefEvents = EffectArray.filter(
    events,
    (event): event is ContextBriefValueEventV1 => event.kind === 'context-brief' && eventMatches(event, options),
  );
  const healthEvents = EffectArray.filter(
    events,
    (event): event is HealthValueEventV1 => event.kind === 'health' && eventMatches(event, options),
  );
  const setupCompletionEvents = EffectArray.filter(
    events,
    (event): event is SetupCompletionValueEventV1 =>
      event.kind === 'setup' && timestampInPeriod(event.timestamp, options),
  );
  const setupLifecycleEvents = EffectArray.filter(
    events,
    (event): event is SetupLifecycleValueEventV1 =>
      event.kind === 'setup-lifecycle' && timestampInPeriod(event.timestamp, options),
  );
  const activationEvents = EffectArray.filter(
    events,
    (event): event is ActivationValueEventV1 =>
      event.kind === 'activation' && timestampInPeriod(event.timestamp, options),
  );
  return {
    contextBrief: {
      attempts: contextBriefEvents.length,
      coverageGaps: sum(EffectArray.map(contextBriefEvents, event => event.coverageGaps)),
      estimatedTokens: sum(EffectArray.map(contextBriefEvents, event => event.estimatedTokens)),
      requestedCodeAnchors: sum(EffectArray.map(contextBriefEvents, event => event.requestedCodeAnchors)),
      resolvedCodeAnchors: sum(EffectArray.map(contextBriefEvents, event => event.resolvedCodeAnchors)),
      successful: EffectArray.filter(contextBriefEvents, event => event.successful).length,
      timeToFirstSuccessfulMillisecondsSamples: EffectArray.map(
        EffectArray.filter(contextBriefEvents, event => event.successful),
        event => event.durationMilliseconds,
      ).sort((left, right) => left - right),
    },
    health: {
      opened: sum(EffectArray.map(healthEvents, event => event.opened)),
      resolved: sum(EffectArray.map(healthEvents, event => event.resolved)),
    },
    ...(setupCompletionEvents.length === 0 && setupLifecycleEvents.length === 0 && activationEvents.length === 0
      ? {}
      : {
          setup: {
            completed: sum([
              ...EffectArray.map(setupCompletionEvents, event => event.completed),
              ...EffectArray.map(
                EffectArray.filter(activationEvents, event => event.phase === 'completed'),
                () => 1,
              ),
            ]),
            failed: EffectArray.filter(setupLifecycleEvents, event => event.phase === 'failed').length,
            started:
              EffectArray.filter(setupLifecycleEvents, event => event.phase === 'started').length +
              EffectArray.filter(activationEvents, event => event.phase === 'started').length,
            supportedAgentReuse: sum([
              ...EffectArray.map(setupCompletionEvents, event => event.supportedAgentReuse),
              ...EffectArray.map(
                EffectArray.filter(activationEvents, event => event.phase === 'second-surface-proof'),
                () => 1,
              ),
            ]),
            timeToFirstEvidenceMillisecondsSamples: [
              ...EffectArray.flatMap(setupLifecycleEvents, event =>
                event.phase === 'completed' && event.timeToFirstEvidenceMilliseconds !== undefined
                  ? [event.timeToFirstEvidenceMilliseconds]
                  : [],
              ),
              ...EffectArray.map(
                EffectArray.filter(activationEvents, event => event.phase === 'first-evidence'),
                event => event.durationMilliseconds,
              ),
            ],
          },
        }),
  };
}

export function summarizeCandidateReviewValue(
  reviews: readonly CandidateReview[],
  options: {readonly from: Date; readonly project?: string; readonly to: Date},
): NonNullable<ValueReportCountsInputV1['knowledgeDelta']> {
  let proposed = 0;
  let approved = 0;
  let edited = 0;
  let rejected = 0;
  let deferred = 0;
  for (const review of reviews) {
    if (options.project !== undefined && review.project !== options.project) continue;
    if (timestampInPeriod(review.createdAt, options)) proposed += review.candidates.length;
    const candidates = new Map(EffectArray.map(review.candidates, candidate => [candidate.candidateId, candidate]));
    for (const event of review.auditEvents) {
      if (!timestampInPeriod(event.at, options)) continue;
      if (event.action === 'apply') {
        approved += 1;
        const candidate = event.candidateId === undefined ? undefined : candidates.get(event.candidateId);
        if (candidate?.applyBodyText !== undefined && candidate.applyBodyText !== candidate.proposedText) edited += 1;
      } else if (event.action === 'reject') {
        rejected += 1;
      } else if (event.action === 'defer') {
        deferred += 1;
      }
    }
  }
  return {approved, deferred, edited, proposed, rejected};
}

const appendValueEvent = Effect.fn('valueReport.appendEvent')(function* (
  agentContextHome: string,
  event: LocalValueEventV1,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = valueEventPath(pathService, agentContextHome);
  yield* withExclusiveFileLock(
    fs,
    `${path}.lock`,
    LOCK_OPTIONS,
    Effect.gen(function* () {
      const existing = yield* readValueEvents(fs, path);
      if (
        'eventId' in event &&
        EffectArray.some(existing, candidate => 'eventId' in candidate && candidate.eventId === event.eventId)
      ) {
        return;
      }
      yield* writeValueEvents(fs, path, retainEvents([...existing, event], event.timestamp));
    }),
  );
});

const mutateValueEvents = Effect.fn('valueReport.mutateEvents')(function* (
  agentContextHome: string,
  apply: boolean,
  retain: (events: readonly LocalValueEventV1[]) => readonly LocalValueEventV1[],
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = valueEventPath(pathService, agentContextHome);
  const inspect = Effect.gen(function* () {
    const before = yield* readValueEvents(fs, path);
    const after = retain(before).slice(-MAX_VALUE_EVENTS);
    if (apply) yield* writeValueEvents(fs, path, after);
    return {after: after.length, applied: apply, before: before.length, removed: before.length - after.length};
  });
  return yield* apply ? withExclusiveFileLock(fs, `${path}.lock`, LOCK_OPTIONS, inspect) : inspect;
});

function eventMatches(
  event: LocalValueEventV1,
  options: {readonly from: Date; readonly project?: string; readonly to: Date},
): boolean {
  const eventProject = 'project' in event ? event.project : undefined;
  return (
    (options.project === undefined || eventProject === options.project) && timestampInPeriod(event.timestamp, options)
  );
}

function timestampInPeriod(timestamp: string, options: {readonly from: Date; readonly to: Date}): boolean {
  const parsed = Date.parse(timestamp);
  return checkedIsFiniteNumber(parsed) && parsed >= options.from.getTime() && parsed <= options.to.getTime();
}

function retainEvents(events: readonly LocalValueEventV1[], now: string): readonly LocalValueEventV1[] {
  const nowMilliseconds = Date.parse(now);
  return EffectArray.filter(
    events,
    event => nowMilliseconds - Date.parse(event.timestamp) <= VALUE_EVENT_RETENTION_MILLISECONDS,
  ).slice(-MAX_VALUE_EVENTS);
}

function valueEventPath(path: Path.Path, agentContextHome: string): string {
  return path.join(agentContextHome, 'value', VALUE_EVENT_FILE);
}

function readValueEvents(
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<readonly LocalValueEventV1[], unknown> {
  return Effect.gen(function* () {
    if (!(yield* fs.exists(path))) return [];
    const raw = yield* fs.readFileString(path);
    return EffectArray.filter(
      EffectArray.map(Effect2.pipe(raw, EffectString.split('\n')), parseValueEvent),
      (event): event is LocalValueEventV1 => event !== undefined,
    ).slice(-MAX_VALUE_EVENTS);
  });
}

function writeValueEvents(
  fs: FileSystem.FileSystem,
  path: string,
  events: readonly LocalValueEventV1[],
): Effect.Effect<void, unknown, Crypto.Crypto | Path.Path> {
  return Effect.gen(function* () {
    const pathService = yield* Path.Path;
    yield* fs.makeDirectory(pathService.dirname(path), {recursive: true});
    const crypto = yield* Crypto.Crypto;
    const temporaryPath = `${path}.${yield* crypto.randomUUIDv4()}.tmp`;
    const content =
      events.length === 0
        ? ''
        : `${EffectArray.join(
            EffectArray.map(events, event => JSON.stringify(event)),
            '\n',
          )}\n`;
    yield* fs.writeFileString(temporaryPath, content, {mode: 0o600});
    yield* fs
      .rename(temporaryPath, path)
      .pipe(Effect.ensuring(fs.remove(temporaryPath, {force: true}).pipe(Effect.ignore)));
  });
}

const ValueEventJsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const withRest = <const S extends Schema.StructWithRest.Objects>(schema: S) =>
  Schema.StructWithRest(schema, [ValueEventJsonRecordSchema]);
const ActivationValueEventSchema = withRest(
  Schema.Struct({
    durationMilliseconds: Schema.Finite,
    eventId: Schema.String,
    kind: Schema.Literal('activation'),
    phase: Schema.Literals(['started', 'first-evidence', 'completed', 'second-surface-proof']),
    timestamp: Schema.String,
    version: Schema.Literal(VALUE_EVENT_VERSION),
  }),
);
const CodexResumePreloadValueEventSchema = withRest(
  Schema.Struct({
    continuationEvidenceState: Schema.optionalKey(Schema.Literals(['background', 'evidence-bearing'])),
    durationMilliseconds: Schema.Finite,
    estimatedTokens: Schema.Finite,
    evidenceState: Schema.optionalKey(Schema.Literals(['degraded', 'no-match', 'partial', 'sufficient'])),
    kind: Schema.Literal('codex-resume-preload'),
    outcome: Schema.Literals([
      'already-preloaded',
      'disabled',
      'ineligible-evidence',
      'injected',
      'invalid-input',
      'lookup-unavailable',
      'manual-context',
      'over-limit',
    ]),
    outputBytes: Schema.Finite,
    timestamp: Schema.String,
    version: Schema.Literal(VALUE_EVENT_VERSION),
  }),
);
const ContextBriefValueEventSchema = withRest(
  Schema.Struct({
    coverageGaps: Schema.Finite,
    durationMilliseconds: Schema.Finite,
    estimatedTokens: Schema.Finite,
    kind: Schema.Literal('context-brief'),
    project: Schema.optionalKey(Schema.String),
    requestedCodeAnchors: Schema.Finite,
    resolvedCodeAnchors: Schema.Finite,
    successful: Schema.Boolean,
    timestamp: Schema.String,
    version: Schema.Literal(VALUE_EVENT_VERSION),
  }),
);
const HealthValueEventSchema = withRest(
  Schema.Struct({
    activeFindings: Schema.Finite,
    kind: Schema.Literal('health'),
    opened: Schema.Finite,
    project: Schema.String,
    resolved: Schema.Finite,
    timestamp: Schema.String,
    version: Schema.Literal(VALUE_EVENT_VERSION),
  }),
);
const SetupCompletionValueEventSchema = withRest(
  Schema.Struct({
    completed: Schema.Literal(1),
    kind: Schema.Literal('setup'),
    supportedAgentReuse: Schema.Literals([0, 1]),
    timestamp: Schema.String,
    version: Schema.Literal(VALUE_EVENT_VERSION),
  }),
);
const SetupLifecycleValueEventSchema = withRest(
  Schema.Struct({
    durationMilliseconds: Schema.Finite,
    kind: Schema.Literal('setup-lifecycle'),
    phase: Schema.Literals(['started', 'completed', 'failed']),
    timeToFirstEvidenceMilliseconds: Schema.optionalKey(Schema.Finite),
    timestamp: Schema.String,
    version: Schema.Literal(VALUE_EVENT_VERSION),
  }),
);

function parseValueEvent(line: string): LocalValueEventV1 | undefined {
  if (!Effect2.pipe(line, EffectString.trim)) return undefined;
  const value = Option.getOrUndefined(Option.liftThrowable((text: string): unknown => JSON.parse(text))(line));
  if (
    !Predicate.isObject(value) ||
    value.version !== VALUE_EVENT_VERSION ||
    typeof value.timestamp !== 'string' ||
    (value.project !== undefined && typeof value.project !== 'string')
  )
    return undefined;
  if (
    value.kind === 'activation' &&
    typeof value.eventId === 'string' &&
    /^[0-9a-f]{64}$/u.test(value.eventId) &&
    (value.phase === 'started' ||
      value.phase === 'first-evidence' ||
      value.phase === 'completed' ||
      value.phase === 'second-surface-proof') &&
    validCount(value.durationMilliseconds)
  ) {
    return Schema.decodeUnknownSync(ActivationValueEventSchema)(value);
  }
  if (
    value.kind === 'codex-resume-preload' &&
    value.project === undefined &&
    [
      'already-preloaded',
      'disabled',
      'ineligible-evidence',
      'injected',
      'invalid-input',
      'lookup-unavailable',
      'manual-context',
      'over-limit',
    ].includes(String(value.outcome)) &&
    (value.continuationEvidenceState === undefined ||
      value.continuationEvidenceState === 'background' ||
      value.continuationEvidenceState === 'evidence-bearing') &&
    (value.evidenceState === undefined ||
      value.evidenceState === 'degraded' ||
      value.evidenceState === 'no-match' ||
      value.evidenceState === 'partial' ||
      value.evidenceState === 'sufficient') &&
    validCount(value.durationMilliseconds) &&
    validCount(value.estimatedTokens) &&
    validCount(value.outputBytes)
  ) {
    return Schema.decodeUnknownSync(CodexResumePreloadValueEventSchema)(value);
  }
  if (
    value.kind === 'context-brief' &&
    typeof value.successful === 'boolean' &&
    validCount(value.coverageGaps) &&
    validCount(value.durationMilliseconds) &&
    validCount(value.estimatedTokens) &&
    validCount(value.requestedCodeAnchors) &&
    validCount(value.resolvedCodeAnchors)
  ) {
    return Schema.decodeUnknownSync(ContextBriefValueEventSchema)(value);
  }
  if (
    value.kind === 'health' &&
    typeof value.project === 'string' &&
    validCount(value.activeFindings) &&
    validCount(value.opened) &&
    validCount(value.resolved)
  ) {
    return Schema.decodeUnknownSync(HealthValueEventSchema)(value);
  }
  if (value.kind === 'setup' && value.project === undefined && value.completed === 1) {
    if (value.supportedAgentReuse === 0 || value.supportedAgentReuse === 1)
      return Schema.decodeUnknownSync(SetupCompletionValueEventSchema)(value);
  }
  if (
    value.kind === 'setup-lifecycle' &&
    value.project === undefined &&
    (value.phase === 'started' || value.phase === 'completed' || value.phase === 'failed') &&
    validCount(value.durationMilliseconds) &&
    (value.timeToFirstEvidenceMilliseconds === undefined || validCount(value.timeToFirstEvidenceMilliseconds)) &&
    (value.phase === 'completed') === (value.timeToFirstEvidenceMilliseconds !== undefined)
  ) {
    return Schema.decodeUnknownSync(SetupLifecycleValueEventSchema)(value);
  }
  return undefined;
}

function boundedCount(value: number): number {
  return checkedIsSafeInteger(value) && value > 0 ? Math.min(10_000, value) : 0;
}

function boundedDuration(value: number): number {
  return checkedIsSafeInteger(value) && value > 0 ? Math.min(604_800_000, value) : 0;
}

function validCount(value: unknown): boolean {
  return checkedIsSafeInteger(value) && value >= 0 && value <= 604_800_000;
}

function sum(values: readonly number[]): number {
  return EffectArray.reduce(values, 0, (total, value) => Math.min(10_000, total + boundedCount(value)));
}
