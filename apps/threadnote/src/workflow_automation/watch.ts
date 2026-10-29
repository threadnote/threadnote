import * as Array from 'effect/Array';
import * as Clock from 'effect/Clock';
import * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import {
  initializeNativeWatch,
  attachNativeWatchConsumer,
  relayNativeWatch,
  reconcileNativeWatch,
  recordNativeWatchDispositions,
  acknowledgeNativeWatch,
  updateNativeWatchWork,
  recordNativeWatchLifecycle,
  type NativeWatchState,
} from '@threadnote/workflow-automations/watch';
import {collectNativeWatchGitHub} from './watch_provider.js';
import {nativeWorkflowError} from './memory.js';
import {
  readNativeWatch,
  writeNativeWatch,
  withNativeWatchControlLock,
  withNativeWatchCollectorLock,
  type NativeWatchEnvelope,
} from './watch_store.js';
import {launchNativeWatchProcess, nativeWatchCollectorAlive} from './watch_process.js';
import {assertNativeWatchOutput, nativeWatchWorkList, nativeWatchWorkDetail} from './watch_output.js';
import {nativeWatchWakeupSchema, type NativeWatchWakeup} from './watch_notification_state.js';
import {makeNativeWatchNotifier, maintainNativeWatchSubscription} from './watch_notification.js';
import {stableJson} from '../workflow_memory/protocol.js';

const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
export const nativeWatchRequestSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  executorVersion: Schema.Literal(1),
  action: Schema.Literal('watch'),
  watchId: id,
  command: Schema.Literals([
    'start',
    'inspect',
    'consumer',
    'relay',
    'wait',
    'disposition',
    'ack',
    'work',
    'work-disposition',
    'work-detail',
    'stop',
  ]),
  pr: Schema.optionalKey(text),
  consumerId: Schema.optionalKey(id),
  wakeupId: Schema.optionalKey(id),
  takeover: Schema.optionalKey(Schema.Boolean),
  wakeup: Schema.optionalKey(nativeWatchWakeupSchema),
  recoverWakeup: Schema.optionalKey(Schema.Boolean),
  deliveryId: Schema.optionalKey(text),
  dispositions: Schema.optionalKey(Schema.Array(Schema.Unknown).check(Schema.isMaxLength(32))),
  expectedRevision: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  timeoutSeconds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 55}))),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 8192}))),
  eventId: Schema.optionalKey(text),
  sourceDigest: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  offsetBytes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({minimum: 0, maximum: 65536}))),
});
const version = {protocolVersion: 1 as const, executorVersion: 1 as const};
const fail = (code: string, message: string) => WorkflowAutomationError.make({code, message});
const required = <A>(value: A | undefined, label: string): A => {
  if (value === undefined) throw fail('invalid-request', 'Provide ' + label + '.');
  return value;
};
const from = <A>(body: () => A) => Effect.try({try: body, catch: nativeWorkflowError});
const load = Effect.fn('workflowWatch.load')(function* (config: RuntimeConfig, watchId: string) {
  const stored = yield* readNativeWatch(config, watchId);
  if (!stored)
    return yield* fail(
      'watch-not-found',
      'Start a fresh native watch explicitly; existing watcher files are not imported.',
    );
  return stored;
});

const health = Effect.fn('workflowWatch.health')(function* (
  stored: Effect.Success<ReturnType<typeof load>>,
  now: number,
) {
  const {envelope, revision} = stored;
  const alive = yield* nativeWatchCollectorAlive(envelope.collector);
  const consumer = envelope.state.consumer;
  const consumerLive = consumer !== null && consumer.leaseUntil > now;
  const sourceErrors = Array.flatMap(envelope.state.sources, source =>
    source.error ? [{source: source.source, ...source.error}] : [],
  );
  return {
    ...version,
    status: 'ok' as const,
    watchId: envelope.state.watchId,
    pr: envelope.state.pr,
    revision,
    head: envelope.state.head,
    prState: envelope.state.prState,
    collector: {
      alive,
      status: envelope.collector?.status ?? 'absent',
      pid: envelope.collector?.pid ?? null,
      lastSeenAt: envelope.collector?.lastSeenAt ?? null,
      nextPollAt: envelope.collector?.nextPollAt ?? null,
      reason: envelope.collector?.reason ?? null,
    },
    consumer: {
      live: consumerLive,
      id: consumer?.id ?? null,
      wakeupId: consumer?.wakeupId ?? null,
      wakeupVerification: envelope.notification
        ? envelope.notification.lastReceipt
          ? 'native-host-receipt-recorded'
          : 'native-host-delivery-pending'
        : 'external-host-receipt-required',
      lastSeenAt: envelope.notification?.lastConsumerAt ?? consumer?.lastSeenAt ?? null,
      ownership: envelope.notification ? 'native-event-subscription' : 'consumer-lease',
      leaseMaintainedAt: envelope.notification ? (consumer?.lastSeenAt ?? null) : null,
    },
    monitoring:
      alive && consumerLive
        ? envelope.notification
          ? 'collector-and-event-subscription-recorded'
          : 'collector-and-consumer-recorded'
        : 'interrupted',
    notification: envelope.notification
      ? {
          host: envelope.notification.target.host,
          status:
            envelope.notification.outbox?.status === 'sending' && !alive
              ? 'ambiguous'
              : (envelope.notification.outbox?.status ?? 'idle'),
          key: envelope.notification.outbox?.key ?? null,
          attempts: envelope.notification.outbox?.attempts ?? 0,
          nextAttemptAt: envelope.notification.outbox?.nextAttemptAt ?? null,
          error:
            envelope.notification.outbox?.status === 'sending' && !alive
              ? 'host-delivery-ambiguous'
              : (envelope.notification.outbox?.error ?? null),
          notifiedThrough: envelope.notification.notifiedThrough,
          lastReceipt: envelope.notification.lastReceipt ?? null,
        }
      : null,
    stopRequested: envelope.stopRequested,
    pending: envelope.state.events.length,
    deliveryId: envelope.state.delivery?.id ?? null,
    work: {
      open: Array.filter(envelope.state.work, item => item.status === 'open').length,
      blocked: Array.filter(envelope.state.work, item => item.status === 'blocked').length,
      terminal: Array.filter(envelope.state.work, item => item.status === 'resolved' || item.status === 'ignored')
        .length,
    },
    sources: Array.map(envelope.state.sources, source => ({
      source: source.source,
      lastCompleteAt: source.lastCompleteAt ?? null,
      items: source.items.length,
    })),
    sourceErrors,
    metrics: envelope.metrics,
    ready: false as const,
  };
});
const initialEnvelope = (state: NativeWatchState): NativeWatchEnvelope => ({
  format: 'threadnote-native-watch-runtime',
  version: 1,
  state,
  provider: {pages: []},
  collector: null,
  stopRequested: false,
  metrics: {
    requests: 0,
    notModified: 0,
    responseBytes: 0,
    graphqlCost: 0,
    providerMilliseconds: 0,
    sweeps: 0,
    consumerReads: 0,
  },
});
/** Subscription identity persists across explicit restarts; reconfiguration is always explicit. */
function attachNotification(
  envelope: NativeWatchEnvelope,
  state: NativeWatchState,
  wakeup: NativeWatchWakeup | undefined,
  now: number,
  recoverWakeup = false,
): NativeWatchEnvelope {
  const consumer = state.consumer!;
  const previous = envelope.notification;
  const sameOwner = previous?.consumerId === consumer.id && previous.wakeupId === consumer.wakeupId;
  const rebind = !sameOwner || (wakeup && stableJson(wakeup) !== stableJson(previous?.target));
  const retainedCursorAttempt =
    previous?.target.host === 'cursor-cli' &&
    previous.outbox &&
    previous.outbox.attempts > 0 &&
    !(previous.outbox.status === 'failed' && previous.outbox.error === 'host-session-owned');
  if (rebind && retainedCursorAttempt)
    throw fail(
      'wakeup-recovery-required',
      'Recover or finalize the original Cursor attempt before changing its owner or target.',
    );
  if (
    previous?.outbox?.status === 'sending' &&
    (!sameOwner || (wakeup && stableJson(wakeup) !== stableJson(previous.target)))
  )
    throw fail(
      'wakeup-in-flight',
      'An in-flight host notification must finish or be explicitly recovered before rebinding.',
    );
  if (!wakeup && !sameOwner) {
    const {notification: _notification, ...legacy} = envelope;
    return {...legacy, state};
  }
  if (sameOwner && (!wakeup || stableJson(wakeup) === stableJson(previous.target)))
    return {
      ...envelope,
      state,
      notification: {
        ...previous,
        lastConsumerAt: now,
        recoveryRequested: recoverWakeup || previous.recoveryRequested || false,
        outbox: previous.outbox,
      },
    };
  return {
    ...envelope,
    state,
    notification: {
      consumerId: consumer.id,
      wakeupId: consumer.wakeupId,
      target: wakeup!,
      notifiedThrough: state.acknowledged,
      lastConsumerAt: now,
      outbox: null,
    },
  };
}

const recoverTerminalNotification = Effect.fn('workflowWatch.recoverTerminalNotification')(function* (
  config: RuntimeConfig,
  watchId: string,
  token: string,
) {
  yield* withNativeWatchCollectorLock(
    config,
    watchId,
    Effect.scoped(
      Effect.gen(function* () {
        const notifier = yield* makeNativeWatchNotifier(config, watchId, token);
        yield* notifier.drain();
      }),
    ),
  );
});

const boundedItems = <A>(items: readonly A[], offset = 0, budget = 4500) => {
  const selected: A[] = [];
  for (const item of items.slice(offset, offset + 32)) {
    if (new TextEncoder().encode(JSON.stringify([...selected, item])).byteLength > budget) break;
    selected.push(item);
  }
  if (!selected.length && items.length > offset)
    throw fail('response-capacity', 'One watch record exceeds the bounded response budget.');
  return {
    items: selected,
    offset,
    nextOffset: offset + selected.length < items.length ? offset + selected.length : null,
  };
};

/** The collector holds a separate lifetime lock; consumption uses only the short state lock. */
export const runNativeWatchCollector = Effect.fn('workflowWatch.collector')(function* (
  config: RuntimeConfig,
  watchId: string,
  token: string,
) {
  return yield* Effect.scoped(
    withNativeWatchCollectorLock(
      config,
      watchId,
      Effect.gen(function* () {
        const system = yield* SystemInfo;
        const startedAt = yield* Clock.currentTimeMillis;
        const startIdentity = yield* system.canonicalProcessStartIdentity?.(system.processId) ??
          system.processStartIdentity(system.processId);
        const activated = yield* withNativeWatchControlLock(
          config,
          watchId,
          Effect.gen(function* () {
            const stored = yield* load(config, watchId);
            if (
              stored.envelope.collector?.token !== token ||
              stored.envelope.stopRequested ||
              stored.envelope.state.prState !== 'open'
            )
              return false;
            yield* writeNativeWatch(
              config,
              {
                ...stored.envelope,
                collector: {
                  token,
                  pid: system.processId,
                  ...(startIdentity === undefined ? {} : {startIdentity}),
                  startedAt,
                  lastSeenAt: startedAt,
                  nextPollAt: startedAt,
                  status: 'running',
                  consecutiveErrors: 0,
                },
              },
              stored.revision,
            );
            return true;
          }),
        );
        if (!activated) return;
        const notifier = yield* makeNativeWatchNotifier(config, watchId, token);
        const finish = (
          status: 'stopped' | 'blocked' | 'terminal',
          reason: string,
          kind?: 'watcher_error' | 'watcher_timeout' | 'watcher_stopped',
        ) =>
          withNativeWatchControlLock(
            config,
            watchId,
            Effect.gen(function* () {
              const stored = yield* load(config, watchId);
              const collector = stored.envelope.collector;
              if (collector?.token !== token) return;
              const now = yield* Clock.currentTimeMillis;
              const state = kind
                ? yield* from(() => recordNativeWatchLifecycle(stored.envelope.state, kind, reason, now))
                : stored.envelope.state;
              yield* writeNativeWatch(
                config,
                {...stored.envelope, state, collector: {...collector, status, reason, lastSeenAt: now}},
                stored.revision,
              );
            }),
          );
        const loop = Effect.gen(function* () {
          for (;;) {
            const before = yield* load(config, watchId);
            if (before.envelope.collector?.token !== token) return;
            const now = yield* Clock.currentTimeMillis;
            yield* maintainNativeWatchSubscription(config, watchId, token);
            yield* notifier.tick();
            if (before.envelope.stopRequested) {
              yield* finish('stopped', 'stop-requested', 'watcher_stopped');
              if (
                before.envelope.notification?.target.host !== 'cursor-cli' ||
                before.envelope.notification.outbox?.status !== 'sending'
              )
                yield* notifier.drain();
              return;
            }
            if (before.envelope.state.prState !== 'open') {
              yield* finish('terminal', before.envelope.state.prState);
              yield* notifier.drain();
              return;
            }
            if (now - startedAt >= 24 * 60 * 60 * 1000) {
              yield* finish('stopped', 'watch-lifetime', 'watcher_timeout');
              yield* notifier.drain();
              return;
            }
            if (before.envelope.collector.nextPollAt > now) {
              yield* Effect.sleep(Math.min(3000, before.envelope.collector.nextPollAt - now));
              continue;
            }
            const collected = yield* collectNativeWatchGitHub(before.envelope.state.pr, before.envelope.provider).pipe(
              Effect.result,
            );
            const stopped = yield* withNativeWatchControlLock(
              config,
              watchId,
              Effect.gen(function* () {
                const current = yield* load(config, watchId);
                const collector = current.envelope.collector;
                if (collector?.token !== token) return true;
                const at = yield* Clock.currentTimeMillis;
                if (collected._tag === 'Failure') {
                  const error = nativeWorkflowError(collected.failure);
                  const count = collector.consecutiveErrors + 1;
                  const terminate = error.retryable !== true || count >= 3;
                  const state =
                    collector.reason === error.code
                      ? current.envelope.state
                      : yield* from(() =>
                          recordNativeWatchLifecycle(current.envelope.state, 'watcher_error', error.code, at),
                        );
                  yield* writeNativeWatch(
                    config,
                    {
                      ...current.envelope,
                      state,
                      collector: {
                        ...collector,
                        lastSeenAt: at,
                        nextPollAt: at + Math.min(900_000, 60_000 * 2 ** (count - 1)),
                        consecutiveErrors: count,
                        status: terminate ? 'blocked' : 'running',
                        reason: error.code,
                      },
                    },
                    current.revision,
                  );
                  return terminate;
                }
                const result = collected.success;
                const state = yield* from(() => reconcileNativeWatch(current.envelope.state, result.sweep));
                const count = result.blockers.length ? collector.consecutiveErrors + 1 : 0;
                const terminate = Array.some(result.blockers, item => !item.retryable) || count >= 3;
                const terminal = state.prState !== 'open';
                const {reason: _reason, ...currentCollector} = collector;
                yield* writeNativeWatch(
                  config,
                  {
                    ...current.envelope,
                    state,
                    provider: result.cache,
                    metrics: {
                      requests: current.envelope.metrics.requests + result.metrics.requests,
                      notModified: current.envelope.metrics.notModified + result.metrics.notModified,
                      responseBytes: current.envelope.metrics.responseBytes + result.metrics.responseBytes,
                      graphqlCost: current.envelope.metrics.graphqlCost + result.metrics.graphqlCost,
                      providerMilliseconds:
                        current.envelope.metrics.providerMilliseconds + result.metrics.providerMilliseconds,
                      sweeps: current.envelope.metrics.sweeps + 1,
                      consumerReads: current.envelope.metrics.consumerReads,
                    },
                    collector: {
                      ...currentCollector,
                      lastSeenAt: at,
                      nextPollAt: Math.max(
                        result.retryAt,
                        count ? at + Math.min(900_000, 60_000 * 2 ** (count - 1)) : at,
                      ),
                      consecutiveErrors: count,
                      status: terminal ? 'terminal' : terminate ? 'blocked' : 'running',
                      ...(terminal
                        ? {reason: state.prState}
                        : result.blockers[0]
                          ? {reason: result.blockers[0].code}
                          : {}),
                    },
                  },
                  current.revision,
                );
                return terminate || terminal;
              }),
            );
            if (stopped) {
              yield* notifier.drain();
              return;
            }
          }
        });
        yield* loop.pipe(
          Effect.catchDefect(error => Effect.fail(nativeWorkflowError(error))),
          Effect.tapError(error =>
            Effect.gen(function* () {
              if (nativeWorkflowError(error).code === 'host-notification-persistence-failed') return;
              yield* finish('blocked', nativeWorkflowError(error).code, 'watcher_error');
              yield* notifier.drain();
            }),
          ),
        );
      }),
    ),
  );
});

const runNativeWatchCommand = Effect.fn('workflowWatch.run')(function* (config: RuntimeConfig, input: unknown) {
  const request = yield* from(() =>
    Schema.decodeUnknownSync(nativeWatchRequestSchema, {onExcessProperty: 'error'})(input),
  );
  if ((request.wakeup || request.recoverWakeup) && request.command !== 'start' && request.command !== 'consumer')
    return yield* fail('invalid-request', 'Host wake configuration requires explicit start or consumer attachment.');
  const now = yield* Clock.currentTimeMillis;
  if (request.command === 'start') {
    const consumerId = required(request.consumerId, 'consumerId');
    const wakeupId = required(request.wakeupId, 'wakeupId');
    const pr = required(request.pr, 'pr');
    const started = yield* withNativeWatchControlLock(
      config,
      request.watchId,
      Effect.gen(function* () {
        const existing = yield* readNativeWatch(config, request.watchId);
        if (existing && existing.envelope.state.pr !== pr)
          return yield* fail('watch-identity-conflict', 'This watch belongs to another PR.');
        let envelope =
          existing?.envelope ?? initialEnvelope(yield* from(() => initializeNativeWatch(request.watchId, pr, now)));
        const state = yield* from(() =>
          attachNativeWatchConsumer(envelope.state, {id: consumerId, wakeupId}, now, {takeover: request.takeover}),
        );
        envelope = yield* from(() => attachNotification(envelope, state, request.wakeup, now, request.recoverWakeup));
        const collector = envelope.collector;
        if (collector && (yield* nativeWatchCollectorAlive(collector)))
          return yield* fail('collector-busy', 'This watch already has a live collector; use its existing relay.');
        if (collector?.status === 'starting' && now - collector.startedAt < 10_000)
          return yield* fail('collector-starting', 'This collector startup is still owned.');
        if (state.prState !== 'open') {
          const saved = yield* writeNativeWatch(config, {...envelope, state}, existing?.revision ?? null);
          return {stored: saved, token: null, recoveryToken: collector?.token};
        }
        const token = yield* (yield* Crypto.Crypto).randomUUIDv4();
        const saved = yield* writeNativeWatch(
          config,
          {
            ...envelope,
            state,
            stopRequested: false,
            collector: {
              token,
              pid: 0,
              startedAt: now,
              lastSeenAt: now,
              nextPollAt: now,
              status: 'starting',
              consecutiveErrors: 0,
            },
          },
          existing?.revision ?? null,
        );
        return {stored: saved, token};
      }),
    );
    if (started.token) yield* launchNativeWatchProcess(config, request.watchId, started.token);
    else if (started.recoveryToken) yield* recoverTerminalNotification(config, request.watchId, started.recoveryToken);
    return yield* health(yield* load(config, request.watchId), yield* Clock.currentTimeMillis);
  }
  const before = yield* load(config, request.watchId);
  if (request.pr !== undefined && request.pr !== before.envelope.state.pr)
    return yield* fail('watch-identity-conflict', 'This watch belongs to another PR.');
  if (request.command === 'inspect') return yield* health(before, now);
  if (request.command === 'work' || request.command === 'work-detail') {
    if (request.expectedRevision !== undefined && request.expectedRevision !== before.revision)
      return yield* fail('watch-state-conflict', 'Watch state changed; reload before reading this command.');
    const identity = {...version, status: 'ok' as const, watchId: request.watchId, revision: before.revision};
    if (request.command === 'work')
      return yield* from(() => ({...identity, work: nativeWatchWorkList(before.envelope.state.work, request.offset)}));
    return yield* from(() => ({
      ...identity,
      workDetail: nativeWatchWorkDetail(
        before.envelope.state.work,
        required(request.eventId, 'eventId'),
        request.offsetBytes,
        request.sourceDigest,
      ),
    }));
  }
  const deadline = now + (request.command === 'wait' ? (request.timeoutSeconds ?? 55) : 0) * 1000;
  for (;;) {
    const result = yield* withNativeWatchControlLock(
      config,
      request.watchId,
      Effect.gen(function* () {
        const stored = yield* load(config, request.watchId);
        if (request.expectedRevision !== undefined && request.expectedRevision !== stored.revision)
          return yield* fail('watch-state-conflict', 'Watch state changed; reload before applying this command.');
        const at = yield* Clock.currentTimeMillis;
        let envelope = stored.envelope;
        let output: Record<string, unknown> = {};
        if (request.command === 'stop') envelope = {...envelope, stopRequested: true};
        else if (request.command === 'consumer') {
          if (
            request.recoverWakeup &&
            envelope.notification?.outbox?.status === 'sending' &&
            (yield* nativeWatchCollectorAlive(envelope.collector))
          )
            return yield* fail(
              'wakeup-in-flight',
              'Wait for the owned host attempt to finish before requesting recovery.',
            );
          const state = yield* from(() =>
            attachNativeWatchConsumer(
              envelope.state,
              {id: required(request.consumerId, 'consumerId'), wakeupId: required(request.wakeupId, 'wakeupId')},
              at,
              {takeover: request.takeover},
            ),
          );
          envelope = yield* from(() => attachNotification(envelope, state, request.wakeup, at, request.recoverWakeup));
        } else {
          const consumerId = required(request.consumerId, 'consumerId');
          if (request.command === 'relay' || request.command === 'wait') {
            const count = Math.max(1, boundedItems(envelope.state.events).items.length);
            const relay = yield* from(() => relayNativeWatch(envelope.state, consumerId, at, count));
            envelope = {
              ...envelope,
              state: relay.state,
              metrics: {...envelope.metrics, consumerReads: envelope.metrics.consumerReads + 1},
            };
            output = {delivery: relay.delivery};
          } else if (request.command === 'disposition')
            envelope = {
              ...envelope,
              state: yield* from(() =>
                recordNativeWatchDispositions(
                  envelope.state,
                  consumerId,
                  required(request.deliveryId, 'deliveryId'),
                  required(request.dispositions, 'dispositions'),
                  at,
                ),
              ),
            };
          else if (request.command === 'work-disposition')
            envelope = {
              ...envelope,
              state: yield* from(() =>
                updateNativeWatchWork(envelope.state, consumerId, required(request.dispositions, 'dispositions'), at),
              ),
            };
          else if (request.command === 'ack')
            envelope = {
              ...envelope,
              state: yield* from(() =>
                acknowledgeNativeWatch(envelope.state, consumerId, required(request.deliveryId, 'deliveryId'), at),
              ),
            };
        }
        if (request.command !== 'stop' && envelope.notification && envelope !== stored.envelope)
          envelope = {...envelope, notification: {...envelope.notification, lastConsumerAt: at}};
        const saved =
          envelope === stored.envelope ? stored : yield* writeNativeWatch(config, envelope, stored.revision);
        const inspected = yield* health(saved, at);
        const {pr: _pr, sources: _sources, metrics: _metrics, ...compact} = inspected;
        return {...compact, ...output};
      }),
    );
    if (request.command === 'consumer' && !result.collector.alive && result.prState !== 'open') {
      const stored = yield* load(config, request.watchId);
      if (stored.envelope.collector?.token) {
        yield* recoverTerminalNotification(config, request.watchId, stored.envelope.collector.token);
        return yield* health(yield* load(config, request.watchId), yield* Clock.currentTimeMillis);
      }
    }
    if (
      request.command !== 'wait' ||
      result.deliveryId ||
      result.pending ||
      !result.collector.alive ||
      (yield* Clock.currentTimeMillis) >= deadline
    )
      return result;
    // Idle probes are read-only. Refresh the consumer lease once per call, not
    // by rewriting the complete watch image on every local wait tick.
    for (;;) {
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0)
        return {
          ...(yield* health(yield* load(config, request.watchId), yield* Clock.currentTimeMillis)),
          delivery: null,
        };
      yield* Effect.sleep(Math.min(1000, remaining));
      const observed = yield* load(config, request.watchId);
      if (
        observed.envelope.state.events.length ||
        observed.envelope.state.prState !== 'open' ||
        observed.envelope.stopRequested ||
        !(yield* nativeWatchCollectorAlive(observed.envelope.collector))
      )
        break;
    }
  }
});

export const runNativeWatch = (config: RuntimeConfig, input: unknown) =>
  runNativeWatchCommand(config, input).pipe(
    Effect.scoped,
    Effect.flatMap(value => from(() => assertNativeWatchOutput(value))),
  );
