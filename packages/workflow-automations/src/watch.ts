import {Array as EffectArray, Option as EffectOption} from 'effect';
import {Schema} from 'effect';
import {sha256HexSync} from '@threadnote/platform/sha256';
import {WorkflowAutomationError} from './contracts.js';
import * as EffectString from 'effect/String';
import * as Effect from 'effect';

const WATCH_CONTROL_CHARACTER = /[^\u0020-\u007e\u00a0-\u{10ffff}]/u;

export const nativeWatchEventLimit = 4096;
export const nativeWatchWorkLimit = 4096;
export const nativeWatchWorkHistoryLimit = 128;
export const nativeWatchDefaultLeaseMilliseconds = 15 * 60 * 1000;
export const nativeWatchMaximumLeaseMilliseconds = 15 * 60 * 1000;
const sources = ['comments', 'reviews', 'threads', 'checks', 'statuses'] as const;
export type NativeWatchSource = (typeof sources)[number];
const sourceSchema = Schema.Literals(sources);
const sha = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const version = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const portable = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  Schema.makeFilter(value =>
    Effect.pipe(value, EffectString.includes('..')) || ['constructor', 'prototype', '__proto__'].includes(value)
      ? 'Reserved identifier.'
      : undefined,
  ),
);
const integerRange = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({minimum, maximum}));
const timestamp = integerRange(0, Number.MAX_SAFE_INTEGER);
const boundedText = (maximum: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximum),
    Schema.makeFilter(value =>
      !Effect.pipe(value, EffectString.trim) || WATCH_CONTROL_CHARACTER.test(value)
        ? 'Text must be nonblank and contain no control characters.'
        : undefined,
    ),
  );
const httpsUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter(value => {
    try {
      const url = new URL(value);
      const hasControl = WATCH_CONTROL_CHARACTER.test(value);
      return url.protocol !== 'https:' ||
        !url.hostname ||
        url.username ||
        url.password ||
        hasControl ||
        url.toString() !== value
        ? 'Invalid canonical HTTPS URL.'
        : undefined;
    } catch {
      return 'Invalid HTTPS URL.';
    }
  }),
);
const prUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u),
  Schema.makeFilter(value => {
    try {
      const url = new URL(value);
      return url.toString() === value ? undefined : 'Pull request URL must be canonical.';
    } catch {
      return 'Invalid pull request URL.';
    }
  }),
);
const entitySchema = Schema.Struct({
  id: boundedText(256),
  version,
  kind: boundedText(64),
  url: Schema.optionalKey(httpsUrl),
  head: Schema.optionalKey(sha),
  bootstrap: Schema.Boolean,
});
const sourceErrorSchema = Schema.Struct({code: boundedText(64), retryable: Schema.Boolean});
const leaseMillisecondsSchema = integerRange(1, nativeWatchMaximumLeaseMilliseconds);
const sourceResultSchema = Schema.Union([
  Schema.Struct({
    source: sourceSchema,
    complete: Schema.Literal(true),
    items: Schema.Array(entitySchema).check(Schema.isMaxLength(10_000)),
    head: Schema.optionalKey(sha),
    at: timestamp,
  }),
  Schema.Struct({
    source: sourceSchema,
    complete: Schema.Literal(false),
    error: sourceErrorSchema,
    at: timestamp,
  }),
]);
const ciSchema = Schema.Struct({
  head: sha,
  complete: Schema.Boolean,
  count: integerRange(0, 1_000_000),
  pending: integerRange(0, 1_000_000),
  failed: integerRange(0, 1_000_000),
  version,
});
const sweepSchema = Schema.Struct({
  head: sha,
  state: Schema.Literals(['open', 'closed', 'merged']),
  at: timestamp,
  startedHead: sha,
  base: Schema.optionalKey(sha),
  startedBase: Schema.optionalKey(sha),
  mergeable: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  sources: Schema.Array(sourceResultSchema).check(Schema.isMaxLength(sources.length)),
  ci: ciSchema,
});
const watchEventSchema = Schema.Struct({
  sequence: integerRange(1, Number.MAX_SAFE_INTEGER),
  id: boundedText(384),
  source: Schema.Union([sourceSchema, Schema.Literal('watch')]),
  kind: boundedText(64),
  key: boundedText(256),
  version,
  url: Schema.optionalKey(httpsUrl),
  head: Schema.optionalKey(sha),
  at: timestamp,
  removed: Schema.Boolean,
  ready: Schema.optionalKey(Schema.Literal(false)),
});
const sourceCheckpointSchema = Schema.Struct({
  source: sourceSchema,
  items: Schema.Array(entitySchema).check(Schema.isMaxLength(10_000)),
  lastCompleteAt: Schema.optionalKey(timestamp),
  error: Schema.optionalKey(sourceErrorSchema),
});
const workSchema = Schema.Struct({
  eventId: boundedText(384),
  status: Schema.Literals(['open', 'blocked', 'resolved', 'ignored']),
  reason: boundedText(1024),
  evidence: boundedText(2048),
  event: watchEventSchema,
  at: timestamp,
});
const dispositionSchema = Schema.Struct({
  eventId: boundedText(384),
  status: Schema.Literals(['open', 'blocked', 'resolved', 'ignored']),
  reason: boundedText(1024),
  evidence: boundedText(2048),
});
const consumerSchema = Schema.Struct({
  id: portable,
  wakeupId: portable,
  lastSeenAt: timestamp,
  leaseUntil: timestamp,
  leaseMilliseconds: leaseMillisecondsSchema,
});
const deliverySchema = Schema.Struct({
  id: boundedText(32),
  first: integerRange(1, Number.MAX_SAFE_INTEGER),
  last: integerRange(1, Number.MAX_SAFE_INTEGER),
});
const ciCheckpointSchema = Schema.Struct({
  head: sha,
  version,
  count: integerRange(1, 1_000_000),
  pending: Schema.Literal(0),
  failed: integerRange(0, 1_000_000),
  firstSeenAt: timestamp,
  emitted: Schema.Boolean,
  ready: Schema.Literal(false),
});
const stateSchema = Schema.Struct({
  format: Schema.Literal('threadnote-native-watch'),
  version: Schema.Literal(1),
  watchId: portable,
  pr: prUrl,
  head: Schema.optionalKey(sha),
  base: Schema.optionalKey(sha),
  mergeConflictVersion: Schema.optionalKey(version),
  prState: Schema.Literals(['open', 'closed', 'merged']),
  nextSequence: integerRange(1, Number.MAX_SAFE_INTEGER),
  acknowledged: integerRange(0, Number.MAX_SAFE_INTEGER),
  events: Schema.Array(watchEventSchema).check(Schema.isMaxLength(nativeWatchEventLimit)),
  sources: Schema.Array(sourceCheckpointSchema).check(Schema.isMaxLength(sources.length)),
  work: Schema.Array(workSchema).check(Schema.isMaxLength(nativeWatchWorkLimit * 2)),
  consumer: Schema.NullOr(consumerSchema),
  delivery: Schema.NullOr(deliverySchema),
  lastAck: Schema.NullOr(boundedText(32)),
  ci: Schema.NullOr(ciCheckpointSchema),
  ciEmittedVersions: Schema.Array(version).check(Schema.isMaxLength(nativeWatchEventLimit)),
});

export type NativeWatchEntity = typeof entitySchema.Type;
export type NativeWatchSourceResult = typeof sourceResultSchema.Type;
export type NativeWatchSweep = typeof sweepSchema.Type;
export type NativeWatchEvent = typeof watchEventSchema.Type;
export type NativeWatchWork = typeof workSchema.Type;
export type NativeWatchConsumer = typeof consumerSchema.Type;
export type NativeWatchDelivery = typeof deliverySchema.Type;
export type NativeWatchCiCheckpoint = typeof ciCheckpointSchema.Type;
export type NativeWatchState = typeof stateSchema.Type;
export type NativeWatchDisposition = typeof dispositionSchema.Type;

const fail = (message: string): never => {
  throw WorkflowAutomationError.make({code: 'invalid-watch', message});
};
const ciEmissionKey = (head: string, providerVersion: string): string =>
  sha256HexSync(`${head}\u0000${providerVersion}`);
const parse = <A>(schema: Schema.ConstraintDecoder<A>, value: unknown, message: string): A => {
  try {
    return Schema.decodeUnknownSync(schema, {onExcessProperty: 'error'})(value);
  } catch {
    return fail(message);
  }
};
const uniqueEntities = (items: readonly NativeWatchEntity[]): void => {
  if (new Set(EffectArray.map(items, item => item.id)).size !== items.length)
    fail('Source contains duplicate entity IDs.');
};
const sourceIndex = (value: string): number =>
  EffectOption.getOrElse(
    EffectArray.findFirstIndex(sources, source => source === value),
    () => -1,
  );
const sourceOrder = (left: string, right: string): number => sourceIndex(left) - sourceIndex(right);
const portableWatchId = (value: string): string => parse(portable, value, 'Invalid watch ID.');

function validateSourceResult(input: NativeWatchSourceResult): void {
  if (input.complete) uniqueEntities(input.items);
}

export function decodeNativeWatchSweep(value: unknown): NativeWatchSweep {
  const sweep = parse(sweepSchema, value, 'Malformed native watch sweep.');
  if (new Set(EffectArray.map(sweep.sources, result => result.source)).size !== sweep.sources.length)
    fail('Watch sweep contains duplicate sources.');
  for (const result of sweep.sources) validateSourceResult(result);
  if (sweep.ci.pending + sweep.ci.failed > sweep.ci.count) fail('CI counts exceed total checks.');
  return sweep;
}

function validateState(state: NativeWatchState): void {
  if (state.acknowledged >= state.nextSequence || state.events.length !== state.nextSequence - state.acknowledged - 1)
    fail('Watch event sequence bounds are inconsistent.');
  const eventIds = new Set<string>();
  EffectArray.forEach(state.events, (event, index) => {
    const expected = state.acknowledged + index + 1;
    if (event.sequence !== expected || event.id !== `${state.watchId}:${expected}` || eventIds.has(event.id))
      fail('Watch event sequence or identity is inconsistent.');
    eventIds.add(event.id);
  });
  if (new Set(EffectArray.map(state.sources, item => item.source)).size !== state.sources.length)
    fail('Watch source checkpoints are duplicated.');
  if (new Set(state.ciEmittedVersions).size !== state.ciEmittedVersions.length)
    fail('Watch CI version history contains duplicates.');
  for (const checkpoint of state.sources) uniqueEntities(checkpoint.items);
  if (new Set(EffectArray.map(state.work, item => item.eventId)).size !== state.work.length)
    fail('Watch work IDs are duplicated.');
  if (
    EffectArray.filter(state.work, item => item.status === 'open' || item.status === 'blocked').length >
    nativeWatchWorkLimit
  )
    fail('Watch unresolved work exceeds its limit.');
  if (state.work.length > nativeWatchWorkLimit * 2) fail('Watch work history exceeds its limit.');
  for (const item of state.work) {
    const prefix = `${state.watchId}:`;
    const sequence = Effect.pipe(item.eventId, EffectString.startsWith(prefix))
      ? Effect.pipe(item.eventId, EffectString.slice(prefix.length))
      : '';
    const numericSequence = Number(sequence);
    if (
      !/^\d+$/u.test(sequence) ||
      numericSequence < 1 ||
      numericSequence >= state.nextSequence ||
      item.event.id !== item.eventId ||
      item.event.sequence !== numericSequence
    )
      fail('Watch work points to an unknown event.');
    const pending = EffectOption.getOrUndefined(
      EffectArray.findFirst(state.events, event => event.id === item.eventId),
    );
    if (pending && JSON.stringify(pending) !== JSON.stringify(item.event))
      fail('Watch work provenance does not match the pending event.');
  }
  if (state.consumer && state.consumer.leaseUntil - state.consumer.lastSeenAt !== state.consumer.leaseMilliseconds)
    fail('Watch consumer lease bounds are inconsistent.');
  if (state.delivery) {
    const {first, last, id} = state.delivery;
    const prefix = state.events.slice(0, last - state.acknowledged);
    if (
      !state.consumer ||
      first !== state.acknowledged + 1 ||
      last < first ||
      prefix.length !== last - first + 1 ||
      prefix[0]?.sequence !== first ||
      prefix.at(-1)?.sequence !== last ||
      id !== `${first}:${last}`
    )
      fail('Watch delivery does not match the pending event prefix and consumer.');
  }
  if (state.lastAck) {
    const match = /^(\d+):(\d+)$/u.exec(state.lastAck);
    if (!match || Number(match[1]) > Number(match[2]) || Number(match[2]) !== state.acknowledged)
      fail('Watch acknowledgement identity is invalid.');
  }
  if (state.ci && (state.ci.pending !== 0 || state.ci.count <= 0 || state.ci.failed > state.ci.count))
    fail('Watch CI checkpoint is inconsistent.');
}

export function decodeNativeWatchState(value: unknown): NativeWatchState {
  const state = parse(stateSchema, value, 'Malformed native watch state.');
  validateState(state);
  return state;
}

export function initializeNativeWatch(watchId: string, pr: string, now: number): NativeWatchState {
  portableWatchId(watchId);
  parse(prUrl, pr, 'Pull request URL must be canonical GitHub URL.');
  parse(timestamp, now, 'Invalid watch timestamp.');
  return {
    format: 'threadnote-native-watch',
    version: 1,
    watchId,
    pr,
    prState: 'open',
    nextSequence: 1,
    acknowledged: 0,
    events: [],
    sources: [],
    work: [],
    consumer: null,
    delivery: null,
    lastAck: null,
    ci: null,
    ciEmittedVersions: [],
  };
}

function appendEvents(
  state: NativeWatchState,
  inputs: readonly Omit<NativeWatchEvent, 'sequence' | 'id'>[],
): NativeWatchState {
  if (state.events.length + inputs.length > nativeWatchEventLimit)
    fail('Watch event capacity reached; retry after durable acknowledgement.');
  let next = state.nextSequence;
  const appended = EffectArray.map(inputs, input => ({...input, sequence: next, id: `${state.watchId}:${next++}`}));
  return {...state, nextSequence: next, events: [...state.events, ...appended]};
}

const eventForEntity = (
  source: NativeWatchSource,
  item: NativeWatchEntity,
  at: number,
  removed = false,
): Omit<NativeWatchEvent, 'sequence' | 'id'> => ({
  source,
  kind: removed ? 'removed' : item.kind,
  key: item.id,
  version: item.version,
  ...(item.url ? {url: item.url} : {}),
  ...(item.head ? {head: item.head} : {}),
  at,
  removed,
});

function eligibleCi(
  sweep: NativeWatchSweep,
  checkpoints: readonly {
    source: NativeWatchSource;
    items: readonly NativeWatchEntity[];
    lastCompleteAt?: number;
    error?: {code: string; retryable: boolean};
  }[],
): boolean {
  return (
    sweep.mergeable !== false &&
    (sweep.startedBase === undefined || sweep.base === undefined || sweep.startedBase === sweep.base) &&
    sweep.startedHead === sweep.head &&
    sweep.ci.head === sweep.head &&
    sweep.ci.complete &&
    sweep.ci.count > 0 &&
    sweep.ci.pending === 0 &&
    EffectArray.every(sources, source => {
      const result = EffectOption.getOrUndefined(EffectArray.findFirst(sweep.sources, item => item.source === source));
      if (!result?.complete) return false;
      return source !== 'checks' && source !== 'statuses' ? true : result.head === sweep.head;
    }) &&
    checkpoints.length === sources.length
  );
}

export function reconcileNativeWatch(input: NativeWatchState, rawSweep: unknown): NativeWatchState {
  const state = decodeNativeWatchState(input);
  const sweep = decodeNativeWatchSweep(rawSweep);
  const checkpoints = new Map(EffectArray.map(state.sources, item => [item.source, item]));
  const events: Omit<NativeWatchEvent, 'sequence' | 'id'>[] = [];
  let head = state.head;
  let prState = state.prState;
  const base = sweep.base ?? state.base;
  let mergeConflictVersion = state.mergeConflictVersion;
  if (state.head !== sweep.head || (sweep.base !== undefined && state.base !== sweep.base) || sweep.mergeable === true)
    mergeConflictVersion = undefined;
  if (sweep.state === 'open' && sweep.mergeable === false && sweep.base !== undefined) {
    const conflictVersion = sha256HexSync(`merge_conflict:${sweep.head}:${sweep.base}`);
    if (mergeConflictVersion !== conflictVersion) {
      events.push({
        source: 'watch',
        kind: 'merge_conflict',
        key: sweep.base,
        version: conflictVersion,
        head: sweep.head,
        url: state.pr,
        at: sweep.at,
        removed: false,
      });
      mergeConflictVersion = conflictVersion;
    }
  }
  if (head === undefined) head = sweep.head;
  else if (head !== sweep.head) {
    events.push({
      source: 'watch',
      kind: 'head_changed',
      key: state.watchId,
      version: sha256HexSync(`head:${sweep.head}`),
      head: sweep.head,
      at: sweep.at,
      removed: false,
    });
    head = sweep.head;
  }
  if (sweep.state !== prState) {
    if (sweep.state !== 'open' && prState !== sweep.state)
      events.push({
        source: 'watch',
        kind: sweep.state,
        key: state.watchId,
        version: sha256HexSync(`state:${sweep.state}:${sweep.head}`),
        head: sweep.head,
        at: sweep.at,
        removed: false,
      });
    prState = sweep.state;
  }
  for (const result of [...sweep.sources].sort((a, b) => sourceOrder(a.source, b.source))) {
    const prior = checkpoints.get(result.source);
    const staleHead =
      result.complete && (result.source === 'checks' || result.source === 'statuses') && result.head !== sweep.head;
    if (!result.complete || staleHead) {
      const error = result.complete ? {code: 'head_changed', retryable: true} : result.error;
      if (prior?.error?.code !== error.code || prior.error.retryable !== error.retryable) {
        events.push({
          source: result.source,
          kind: 'source_error',
          key: result.source,
          version: sha256HexSync(`error:${error.code}:${error.retryable}`),
          at: result.at,
          removed: false,
        });
      }
      checkpoints.set(result.source, {
        source: result.source,
        items: prior?.items ?? [],
        ...(prior?.lastCompleteAt === undefined ? {} : {lastCompleteAt: prior.lastCompleteAt}),
        error,
      });
      continue;
    }
    uniqueEntities(result.items);
    const oldItems = new Map(EffectArray.map(prior?.items ?? [], item => [item.id, item]));
    const newItems = new Map(EffectArray.map(result.items, item => [item.id, item]));
    for (const item of result.items) {
      const isNonActionableCiUpdate =
        (result.source === 'checks' || result.source === 'statuses') && item.kind === 'ci_update';
      const old = oldItems.get(item.id);
      if (old) {
        if (
          (old.version !== item.version || old.kind !== item.kind || old.head !== item.head) &&
          !isNonActionableCiUpdate
        )
          events.push(eventForEntity(result.source, item, result.at));
      } else if ((prior?.lastCompleteAt !== undefined || item.bootstrap) && !isNonActionableCiUpdate)
        events.push(eventForEntity(result.source, item, result.at));
    }
    for (const item of prior?.items ?? []) {
      // Head changes already invalidate prior CI. Retain their work without
      // turning the replaced checkpoint into one removal event per old check.
      const supersededCi =
        (result.source === 'checks' || result.source === 'statuses') &&
        item.head !== undefined &&
        item.head !== sweep.head;
      if (!newItems.has(item.id) && !supersededCi) events.push(eventForEntity(result.source, item, result.at, true));
    }
    checkpoints.set(result.source, {source: result.source, items: result.items, lastCompleteAt: result.at});
  }
  let ci: NativeWatchCiCheckpoint | null = null;
  let ciEmittedVersions = state.ciEmittedVersions;
  const orderedCheckpoints = [...checkpoints.values()].sort((a, b) => sourceOrder(a.source, b.source));
  if (eligibleCi(sweep, orderedCheckpoints)) {
    const prior = state.ci;
    const same = prior?.head === sweep.head && prior.version === sweep.ci.version;
    const firstSeenAt = same ? prior.firstSeenAt : sweep.at;
    const emissionKey = ciEmissionKey(sweep.head, sweep.ci.version);
    const emitted = state.ciEmittedVersions.includes(emissionKey) || (same && prior.emitted);
    ci = {
      head: sweep.head,
      version: sweep.ci.version,
      count: sweep.ci.count,
      pending: 0,
      failed: sweep.ci.failed,
      firstSeenAt,
      emitted,
      ready: false,
    };
    if (!emitted && sweep.at - firstSeenAt >= 60_000) {
      if (ciEmittedVersions.length >= nativeWatchEventLimit) fail('Watch CI version history capacity reached.');
      events.push({
        source: 'checks',
        kind: 'ci_complete',
        key: sweep.ci.version,
        version: sweep.ci.version,
        head: sweep.head,
        at: sweep.at,
        removed: false,
        ready: false,
      });
      ci = {...ci, emitted: true};
      ciEmittedVersions = [...ciEmittedVersions, emissionKey];
    }
  }
  const withDiff = appendEvents(state, events);
  const work = [...withDiff.work];
  for (const event of withDiff.events.slice(state.events.length)) {
    if (event.kind === 'merge_conflict')
      work.push({
        eventId: event.id,
        status: 'open',
        reason: 'Pull request has an explicit merge conflict.',
        evidence: state.pr,
        event,
        at: sweep.at,
      });
  }
  if (
    EffectArray.filter(work, item => item.status === 'open' || item.status === 'blocked').length > nativeWatchWorkLimit
  )
    fail('Unresolved watch work capacity reached.');
  const {mergeConflictVersion: _previousConflict, ...withoutConflict} = withDiff;
  return decodeNativeWatchState({
    ...withoutConflict,
    head,
    ...(base === undefined ? {} : {base}),
    ...(mergeConflictVersion === undefined ? {} : {mergeConflictVersion}),
    prState,
    sources: orderedCheckpoints,
    ci,
    ciEmittedVersions,
    work,
  });
}

export function attachNativeWatchConsumer(
  input: NativeWatchState,
  owner: {readonly id: string; readonly wakeupId: string},
  now: number,
  options: {readonly takeover?: boolean; readonly leaseMilliseconds?: number} = {},
): NativeWatchState {
  const state = decodeNativeWatchState(input);
  const id = parse(portable, owner.id, 'Invalid consumer ID.');
  const wakeupId = parse(portable, owner.wakeupId, 'Invalid wakeup ID.');
  parse(timestamp, now, 'Invalid consumer timestamp.');
  const leaseMilliseconds = options.leaseMilliseconds ?? nativeWatchDefaultLeaseMilliseconds;
  parse(leaseMillisecondsSchema, leaseMilliseconds, 'Invalid consumer lease.');
  const current = state.consumer;
  if (current?.id === id && now < current.lastSeenAt) fail('Consumer lease timestamps must not move backwards.');
  if (current && current.id !== id && current.leaseUntil > now) fail('Another watch consumer has a live lease.');
  if (current && current.id !== id && current.leaseUntil <= now && !options.takeover)
    fail('Expired watch consumer requires explicit takeover.');
  return decodeNativeWatchState({
    ...state,
    consumer: {id, wakeupId, lastSeenAt: now, leaseUntil: now + leaseMilliseconds, leaseMilliseconds},
  });
}

function requireConsumer(state: NativeWatchState, consumerId: string, now: number): NativeWatchConsumer {
  const consumer = state.consumer;
  if (!consumer || consumer.id !== consumerId || consumer.leaseUntil <= now)
    return fail('Watch consumer does not own a live lease.');
  if (now < consumer.lastSeenAt) return fail('Consumer lease timestamps must not move backwards.');
  return consumer;
}

export function relayNativeWatch(
  input: NativeWatchState,
  consumerId: string,
  now: number,
  maximum = 16,
): {
  readonly state: NativeWatchState;
  readonly delivery:
    null | (NativeWatchDelivery & {readonly consumerId: string; readonly events: readonly NativeWatchEvent[]});
  readonly work: readonly NativeWatchWork[];
} {
  const state = decodeNativeWatchState(input);
  const consumer = requireConsumer(state, consumerId, now);
  parse(timestamp, now, 'Invalid relay timestamp.');
  parse(integerRange(1, 32), maximum, 'Invalid relay event limit.');
  const refreshed = {...consumer, lastSeenAt: now, leaseUntil: now + consumer.leaseMilliseconds};
  const delivery =
    state.delivery ??
    (() => {
      const first = state.events[0]?.sequence;
      if (first === undefined) return null;
      const events = state.events.slice(0, maximum);
      const last = events.at(-1)!.sequence;
      return {id: `${first}:${last}`, first, last};
    })();
  const next = decodeNativeWatchState({...state, consumer: refreshed, delivery});
  return {
    state: next,
    delivery: delivery
      ? {...delivery, consumerId, events: next.events.slice(0, delivery.last - next.acknowledged)}
      : null,
    work: next.work,
  };
}

function compactWork(work: readonly NativeWatchWork[], acknowledged: number, watchId: string): NativeWatchWork[] {
  const active = EffectArray.filter(work, item => item.status === 'open' || item.status === 'blocked');
  const prefix = `${watchId}:`;
  const terminal = EffectArray.filter(work, item => item.status === 'resolved' || item.status === 'ignored');
  const unacknowledged = EffectArray.filter(
    terminal,
    item => Number(Effect.pipe(item.eventId, EffectString.slice(prefix.length))) > acknowledged,
  );
  const history = EffectArray.filter(
    work,
    item =>
      (item.status === 'resolved' || item.status === 'ignored') &&
      Number(Effect.pipe(item.eventId, EffectString.slice(prefix.length))) <= acknowledged,
  ).slice(-nativeWatchWorkHistoryLimit);
  return [...active, ...unacknowledged, ...history];
}

export function recordNativeWatchDispositions(
  input: NativeWatchState,
  consumerId: string,
  deliveryId: string,
  items: readonly unknown[],
  now: number,
): NativeWatchState {
  const state = decodeNativeWatchState(input);
  requireConsumer(state, consumerId, now);
  const delivery = state.delivery;
  if (!delivery || delivery.id !== deliveryId)
    return fail('Disposition delivery does not match the current pending delivery.');
  parse(timestamp, now, 'Invalid disposition timestamp.');
  const dispositions = EffectArray.map(items, item => parse(dispositionSchema, item, 'Invalid watch disposition.'));
  if (new Set(EffectArray.map(dispositions, item => item.eventId)).size !== dispositions.length)
    fail('Duplicate event disposition.');
  const allowed = new Map(
    EffectArray.map(state.events.slice(0, delivery.last - state.acknowledged), event => [event.id, event]),
  );
  if (EffectArray.some(dispositions, item => !allowed.has(item.eventId)))
    fail('Disposition refers to an event outside the pending delivery.');
  const work = new Map(EffectArray.map(state.work, item => [item.eventId, item]));
  for (const item of dispositions) {
    const event = allowed.get(item.eventId);
    if (!event) return fail('Disposition refers to an event outside the pending delivery.');
    const prior = work.get(item.eventId);
    if (prior && prior.status === item.status && prior.reason === item.reason && prior.evidence === item.evidence)
      continue;
    if (prior && (prior.status === 'resolved' || prior.status === 'ignored'))
      fail('Resolved watch work requires a new event before it can change.');
    work.set(item.eventId, {...item, event: prior?.event ?? event, at: now});
  }
  const all = [...work.values()];
  if (
    EffectArray.filter(all, item => item.status === 'open' || item.status === 'blocked').length > nativeWatchWorkLimit
  )
    fail('Unresolved watch work capacity reached.');
  if (all.length > nativeWatchWorkLimit * 2)
    fail('Watch work capacity reached; acknowledge delivered events to compact resolved history.');
  return decodeNativeWatchState({...state, work: all});
}

export function updateNativeWatchWork(
  input: NativeWatchState,
  consumerId: string,
  items: readonly unknown[],
  now: number,
): NativeWatchState {
  const state = decodeNativeWatchState(input);
  requireConsumer(state, consumerId, now);
  parse(timestamp, now, 'Invalid work update timestamp.');
  if (items.length > 32) fail('Work update exceeds its event limit.');
  const dispositions = EffectArray.map(items, item => parse(dispositionSchema, item, 'Invalid watch work update.'));
  if (new Set(EffectArray.map(dispositions, item => item.eventId)).size !== dispositions.length)
    fail('Duplicate work update IDs.');
  const work = new Map(EffectArray.map(state.work, item => [item.eventId, item]));
  for (const disposition of dispositions) {
    const prior = work.get(disposition.eventId);
    if (!prior) return fail('Work update must refer to an existing event disposition.');
    const item: NativeWatchWork = {...disposition, event: prior.event, at: now};
    if (prior.status === item.status && prior.reason === item.reason && prior.evidence === item.evidence) continue;
    if ((prior.status === 'resolved' || prior.status === 'ignored') && item.status !== 'open')
      fail('Resolved work can only be reopened as open.');
    work.set(item.eventId, item);
  }
  const next = [...work.values()];
  if (
    EffectArray.filter(next, item => item.status === 'open' || item.status === 'blocked').length > nativeWatchWorkLimit
  )
    fail('Unresolved watch work exceeds its limit.');
  return decodeNativeWatchState({...state, work: compactWork(next, state.acknowledged, state.watchId)});
}

export function acknowledgeNativeWatch(
  input: NativeWatchState,
  consumerId: string,
  deliveryId: string,
  now: number,
): NativeWatchState {
  const state = decodeNativeWatchState(input);
  requireConsumer(state, consumerId, now);
  parse(timestamp, now, 'Invalid acknowledgement timestamp.');
  if (state.lastAck === deliveryId) return state;
  const delivery = state.delivery;
  if (!delivery || delivery.id !== deliveryId) return fail('Acknowledgement does not match the current delivery.');
  const delivered = state.events.slice(0, delivery.last - state.acknowledged);
  const work = new Map(EffectArray.map(state.work, item => [item.eventId, item]));
  if (EffectArray.some(delivered, event => !work.has(event.id)))
    fail('Every delivered event needs a durable disposition before acknowledgement.');
  const remaining = state.events.slice(delivered.length);
  return decodeNativeWatchState({
    ...state,
    acknowledged: delivery.last,
    events: remaining,
    delivery: null,
    lastAck: deliveryId,
    work: compactWork(state.work, delivery.last, state.watchId),
  });
}

export function recordNativeWatchLifecycle(
  input: NativeWatchState,
  kind: 'watcher_error' | 'watcher_timeout' | 'watcher_stopped',
  code: string,
  now: number,
): NativeWatchState {
  const state = decodeNativeWatchState(input);
  parse(boundedText(64), code, 'Invalid watch lifecycle code.');
  parse(timestamp, now, 'Invalid watch lifecycle timestamp.');
  const eventVersion = sha256HexSync(`${kind}:${code}`);
  const last = state.events.at(-1);
  if (last?.source === 'watch' && last.kind === kind && last.key === code && last.version === eventVersion)
    return state;
  return decodeNativeWatchState(
    appendEvents(state, [
      {
        source: 'watch',
        kind,
        key: code,
        version: eventVersion,
        url: state.pr,
        ...(state.head ? {head: state.head} : {}),
        at: now,
        removed: false,
      },
    ]),
  );
}
