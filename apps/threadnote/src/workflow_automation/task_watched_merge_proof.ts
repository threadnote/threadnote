import type {Effect} from 'effect';
import * as EffectArray from 'effect/Array';
import * as Option from 'effect/Option';
import * as EffectString from 'effect/String';
import type {readNativeWatch} from './watch_store.js';

type WatchEnvelope = NonNullable<Effect.Success<ReturnType<typeof readNativeWatch>>>['envelope'];

const mergedWatchEvent = (state: WatchEnvelope['state']) => {
  const matches = ({source, kind, key, removed, head}: (typeof state.events)[number]) =>
    source === 'watch' && kind === 'merged' && key === state.watchId && !removed && head === state.head;
  return (
    Option.getOrUndefined(EffectArray.findFirst(state.events, matches)) ??
    Option.getOrUndefined(EffectArray.findFirst(state.work, ({event}) => matches(event)))?.event
  );
};

const mergedWatchHostReceipt = ({state, collector, notification}: WatchEnvelope, requiredReceipt?: string) => {
  if (
    state.prState !== 'merged' ||
    collector?.status !== 'terminal' ||
    collector.reason !== 'merged' ||
    !notification ||
    notification.recoveryRequested
  )
    return undefined;

  const event = mergedWatchEvent(state);
  if (!event) return undefined;
  const covers = (first: number, last: number) => first <= event.sequence && event.sequence <= last;
  const {outbox, lastReceipt} = notification;
  if (
    outbox?.receipt &&
    (requiredReceipt === undefined || outbox.receipt === requiredReceipt) &&
    !outbox.error &&
    (outbox.status === 'queued' || outbox.status === 'completed')
  ) {
    // A claimed Codex arrival can cover events beyond the original notice range.
    const last = outbox.status === 'queued' ? Math.max(outbox.last, outbox.consumedThrough ?? 0) : outbox.last;
    if (covers(outbox.first, last))
      return {kind: 'host' as const, receipt: outbox.receipt, first: outbox.first, last, sequence: event.sequence};
  }
  if (!lastReceipt || (requiredReceipt !== undefined && lastReceipt.receipt !== requiredReceipt)) return undefined;
  const [, firstField, lastField] = EffectString.split(lastReceipt.key, ':');
  const first = Number(firstField);
  const last = Number(lastField);
  return covers(first, last)
    ? {kind: 'host' as const, receipt: lastReceipt.receipt, first, last, sequence: event.sequence}
    : undefined;
};

/** Direct relay can ACK the merge before the notifier stages a host message. */
export const mergedWatchProof = (envelope: WatchEnvelope) => {
  const host = mergedWatchHostReceipt(envelope);
  if (host) return host;
  const {state, collector, notification} = envelope;
  if (
    state.prState !== 'merged' ||
    collector?.status !== 'terminal' ||
    collector.reason !== 'merged' ||
    !notification ||
    notification.recoveryRequested ||
    state.lastAck === null
  )
    return undefined;
  const event = mergedWatchEvent(state);
  if (
    event &&
    event.sequence <= state.acknowledged &&
    EffectArray.some(
      state.work,
      item => item.eventId === event.id && (item.status === 'resolved' || item.status === 'ignored'),
    )
  )
    return {kind: 'ack' as const, sequence: event.sequence};
  return undefined;
};

export const receiptCitesMergedWatchProof = (evidence: string | undefined, envelope: WatchEnvelope) => {
  if (!evidence || !EffectString.startsWith('native-watch-revision:')(evidence)) return false;
  const host = hostProofSuffix.exec(evidence);
  const ack = ackProofSuffix.exec(evidence);
  if (host || ack) {
    // The cycle verified the exact event when it wrote the receipt. An ACKed event can age out of work history.
    const [first, last, sequence] = host
      ? EffectArray.map(host.slice(1), Number)
      : [Number(ack![1]), Number(ack![1]), Number(ack![1])];
    const state = envelope.state;
    const event = mergedWatchEvent(state);
    return (
      Number.isSafeInteger(first) &&
      Number.isSafeInteger(last) &&
      Number.isSafeInteger(sequence) &&
      first > 0 &&
      first <= sequence &&
      sequence <= last &&
      last < state.nextSequence &&
      (host !== null || sequence <= state.acknowledged) &&
      (event ? event.sequence === sequence : sequence <= state.acknowledged)
    );
  }
  // Legacy proof has no range. Its exact host ID must still cover the merged event.
  const legacy = /;host-receipt:([a-f0-9-]{36})$/u.exec(evidence);
  return legacy !== null && mergedWatchHostReceipt(envelope, legacy[1]) !== undefined;
};

const hostProofSuffix = /;merged-notice:(\d+):(\d+):(\d+);host-receipt:[a-f0-9-]{36}$/u;
const ackProofSuffix = /;merged-ack:(\d+)$/u;

export const hasMergedWatchProofMarker = (evidence: string) =>
  EffectString.includes(';merged-notice:')(evidence) || EffectString.includes(';merged-ack:')(evidence);

export const mergedWatchProofMarker = (proof: NonNullable<ReturnType<typeof mergedWatchProof>>) =>
  proof.kind === 'host'
    ? `merged-notice:${proof.first}:${proof.last}:${proof.sequence};host-receipt:${proof.receipt}`
    : `merged-ack:${proof.sequence}`;
