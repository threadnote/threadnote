import * as Array from 'effect/Array';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as EffectString from 'effect/String';
import type {NativeWatchState} from '@threadnote/workflow-automations/watch';

const integer = Schema.Int.check(Schema.isBetween({minimum: 0, maximum: Number.MAX_SAFE_INTEGER}));
const portable = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const uuid = Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu));
/** Explicit host configuration comes only from an authorized start/consumer request. */
const absolute = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.isPattern(/^(?:\/|[A-Za-z]:[\\/])/u),
  Schema.makeFilter(value =>
    Array.some([...value], character =>
      Option.exists(EffectString.codePointAt(character, 0), code => code < 32 || (code >= 127 && code <= 159)),
    )
      ? 'Path contains control characters.'
      : undefined,
  ),
);
export const nativeWatchWakeupSchema = Schema.Union([
  Schema.Struct({
    host: Schema.Literal('codex'),
    executable: absolute.check(Schema.isPattern(/[\\/]codex(?:\.exe)?$/iu)),
    threadId: uuid,
  }),
  Schema.Struct({
    host: Schema.Literal('cursor-cli'),
    executable: absolute.check(Schema.isPattern(/[\\/](?:agent|cursor-agent)(?:\.exe)?$/iu)),
    sessionId: uuid,
    workspace: absolute,
    exclusiveSession: Schema.Literal(true),
  }),
]);
export type NativeWatchWakeup = typeof nativeWatchWakeupSchema.Type;
export const nativeWatchNotificationSchema = Schema.Struct({
  consumerId: portable,
  wakeupId: portable,
  target: nativeWatchWakeupSchema,
  notifiedThrough: integer,
  lastConsumerAt: integer,
  recoveryRequested: Schema.optionalKey(Schema.Boolean),
  outbox: Schema.NullOr(
    Schema.Struct({
      key: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[0-9]+:[0-9]+$/u)),
      first: integer,
      last: integer,
      createdAt: integer,
      attempts: Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 3})),
      nextAttemptAt: integer,
      attemptId: Schema.optionalKey(uuid),
      collectorToken: Schema.optionalKey(uuid),
      status: Schema.Literals(['pending', 'sending', 'queued', 'completed', 'failed']),
      receipt: Schema.optionalKey(uuid),
      // New Codex attempts start at zero; positive values claim the arriving notice's durable backlog.
      consumedThrough: Schema.optionalKey(integer),
      error: Schema.optionalKey(
        Schema.Literals([
          'host-command-failed',
          'host-receipt-invalid',
          'host-session-interrupted',
          'host-delivery-ambiguous',
          'host-session-owned',
        ]),
      ),
    }),
  ),
  lastReceipt: Schema.optionalKey(
    Schema.Struct({
      key: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[0-9]+:[0-9]+$/u)),
      receipt: uuid,
      attemptId: uuid,
      kind: Schema.Literals(['queued-message', 'cli-session-completed']),
      at: integer,
    }),
  ),
});
export type NativeWatchNotification = typeof nativeWatchNotificationSchema.Type;

export function validateNativeWatchNotification(value: NativeWatchNotification, state: NativeWatchState): void {
  const consumer = state.consumer;
  if (
    !consumer ||
    consumer.id !== value.consumerId ||
    consumer.wakeupId !== value.wakeupId ||
    value.notifiedThrough >= state.nextSequence
  )
    throw new Error('Notification owner or watermark mismatch.');
  if (value.lastReceipt) {
    const [watchId, first, last] = EffectString.split(value.lastReceipt.key, ':');
    if (
      watchId !== state.watchId ||
      !Number.isSafeInteger(Number(first)) ||
      Number(first) < 1 ||
      Number(first) > Number(last) ||
      Number(last) > value.notifiedThrough ||
      (value.target.host === 'cursor-cli') !== (value.lastReceipt.kind === 'cli-session-completed') ||
      (value.target.host === 'cursor-cli' && value.lastReceipt.receipt !== value.target.sessionId)
    )
      throw new Error('Notification receipt mismatch.');
  }
  const pending = value.outbox;
  if (
    pending &&
    (pending.first !== value.notifiedThrough + 1 ||
      pending.last < pending.first ||
      pending.last >= state.nextSequence ||
      pending.key !== `${state.watchId}:${pending.first}:${pending.last}` ||
      (pending.status === 'queued' || pending.status === 'completed') !== (pending.receipt !== undefined) ||
      ((pending.status === 'sending' || pending.status === 'queued' || pending.status === 'completed') &&
        (!pending.attemptId || !pending.collectorToken)) ||
      (pending.status === 'failed' && pending.attempts < 1) ||
      (pending.status === 'queued' && value.target.host !== 'codex') ||
      (pending.consumedThrough !== undefined &&
        (value.target.host !== 'codex' ||
          (pending.consumedThrough !== 0 &&
            (pending.attempts < 1 ||
              pending.status === 'pending' ||
              pending.consumedThrough < pending.last ||
              pending.consumedThrough >= state.nextSequence)))) ||
      (pending.status === 'completed' &&
        (value.target.host !== 'cursor-cli' || pending.receipt !== value.target.sessionId)))
  )
    throw new Error('Notification outbox mismatch.');
}

/** A matching arriving notice claims its current backlog; it never disposes or acknowledges work. */
export function consumeNativeWatchNotification(
  value: NativeWatchNotification,
  state: NativeWatchState,
  route: {consumerId: string; wakeupId: string; eventKey: string; attemptId?: string},
): NativeWatchNotification {
  const pending = value.outbox;
  if (
    value.target.host !== 'codex' ||
    value.consumerId !== route.consumerId ||
    value.wakeupId !== route.wakeupId ||
    state.consumer?.id !== route.consumerId ||
    state.consumer.wakeupId !== route.wakeupId ||
    !pending ||
    pending.key !== route.eventKey ||
    pending.attempts < 1 ||
    pending.status === 'pending' ||
    (pending.consumedThrough !== undefined && pending.consumedThrough !== 0) ||
    (route.attemptId !== pending.attemptId && !(pending.consumedThrough === undefined && route.attemptId === undefined))
  )
    return value;
  return {...value, outbox: {...pending, consumedThrough: state.nextSequence - 1}};
}

/** Only newly appended durable sequences create work; pending feedback and unresolved work do not. */
export function stageNativeWatchNotification(
  value: NativeWatchNotification,
  state: NativeWatchState,
  now: number,
): NativeWatchNotification {
  let notification = value;
  const pending = value.outbox;
  if (pending) {
    // Only a never-invoked range can be suppressed or trimmed. Invoked ambiguity and host receipts stay retained.
    if (pending.status !== 'pending' || pending.attempts !== 0 || state.acknowledged < pending.first) return value;
    notification = {...value, notifiedThrough: Math.max(value.notifiedThrough, state.acknowledged), outbox: null};
    if (state.acknowledged < pending.last) {
      const first = state.acknowledged + 1;
      return {...notification, outbox: {...pending, first, key: `${state.watchId}:${first}:${pending.last}`}};
    }
  } else if (state.acknowledged > value.notifiedThrough) notification = {...value, notifiedThrough: state.acknowledged};
  if (notification.notifiedThrough === state.nextSequence - 1) return notification;
  const first = notification.notifiedThrough + 1;
  const last = state.nextSequence - 1;
  return {
    ...notification,
    outbox: {
      key: `${state.watchId}:${first}:${last}`,
      first,
      last,
      createdAt: now,
      attempts: 0,
      nextAttemptAt: now,
      status: 'pending',
      ...(value.target.host === 'codex' ? {consumedThrough: 0} : {}),
    },
  };
}

export function nativeWatchNotice(
  route: {home: string; watchId: string; consumerId: string; wakeupId: string},
  value: NonNullable<NativeWatchNotification['outbox']>,
): string {
  const locator = JSON.stringify({...route, eventKey: value.key, attemptId: value.attemptId});
  if (new TextEncoder().encode(locator).byteLength > 6144)
    throw new Error('Host notification route exceeds its byte budget.');
  return `Threadnote watch event. Route=${locator}. Relay this home/watch with consumerId, wakeupId, eventKey and attemptId to claim arrival. Inspect durable delivery/work; preserve disposition and ACK semantics. Scope this home to this watch; preserve caller workspace and default home.`;
}
