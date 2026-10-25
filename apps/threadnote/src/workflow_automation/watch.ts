import {Clock, Crypto, Effect, Schema} from 'effect';
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
  type NativeWatchDisposition,
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

const id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u));
const text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
const requestSchema = Schema.Struct({
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
  const sourceErrors = envelope.state.sources.flatMap(source =>
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
      wakeupVerification: 'external-host-receipt-required' as const,
      lastSeenAt: consumer?.lastSeenAt ?? null,
    },
    monitoring: alive && consumerLive ? 'collector-and-consumer-recorded' : 'interrupted',
    stopRequested: envelope.stopRequested,
    pending: envelope.state.events.length,
    deliveryId: envelope.state.delivery?.id ?? null,
    work: {
      open: envelope.state.work.filter(item => item.status === 'open').length,
      blocked: envelope.state.work.filter(item => item.status === 'blocked').length,
      terminal: envelope.state.work.filter(item => item.status === 'resolved' || item.status === 'ignored').length,
    },
    sources: envelope.state.sources.map(source => ({
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
  return yield* withNativeWatchCollectorLock(
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
          if (before.envelope.stopRequested) {
            yield* finish('stopped', 'stop-requested', 'watcher_stopped');
            return;
          }
          if (before.envelope.state.prState !== 'open') {
            yield* finish('terminal', before.envelope.state.prState);
            return;
          }
          if (now - startedAt >= 24 * 60 * 60 * 1000) {
            yield* finish('stopped', 'watch-lifetime', 'watcher_timeout');
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
                const state = yield* from(() =>
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
              const terminate = result.blockers.some(item => !item.retryable) || count >= 3;
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
          if (stopped) return;
        }
      });
      yield* loop.pipe(
        Effect.catchDefect(error => Effect.fail(nativeWorkflowError(error))),
        Effect.tapError(error => finish('blocked', nativeWorkflowError(error).code, 'watcher_error')),
      );
    }),
  );
});

const runNativeWatchCommand = Effect.fn('workflowWatch.run')(function* (config: RuntimeConfig, input: unknown) {
  const request = yield* from(() => Schema.decodeUnknownSync(requestSchema, {onExcessProperty: 'error'})(input));
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
        const envelope =
          existing?.envelope ?? initialEnvelope(yield* from(() => initializeNativeWatch(request.watchId, pr, now)));
        const state = yield* from(() =>
          attachNativeWatchConsumer(envelope.state, {id: consumerId, wakeupId}, now, {takeover: request.takeover}),
        );
        const collector = envelope.collector;
        if (collector && (yield* nativeWatchCollectorAlive(collector)))
          return yield* fail('collector-busy', 'This watch already has a live collector; use its existing relay.');
        if (collector?.status === 'starting' && now - collector.startedAt < 10_000)
          return yield* fail('collector-starting', 'This collector startup is still owned.');
        if (state.prState !== 'open') {
          const saved = yield* writeNativeWatch(config, {...envelope, state}, existing?.revision ?? null);
          return {stored: saved, token: null};
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
        else if (request.command === 'consumer')
          envelope = {
            ...envelope,
            state: yield* from(() =>
              attachNativeWatchConsumer(
                envelope.state,
                {id: required(request.consumerId, 'consumerId'), wakeupId: required(request.wakeupId, 'wakeupId')},
                at,
                {takeover: request.takeover},
              ),
            ),
          };
        else {
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
                  required(request.dispositions, 'dispositions') as NativeWatchDisposition[],
                  at,
                ),
              ),
            };
          else if (request.command === 'work-disposition')
            envelope = {
              ...envelope,
              state: yield* from(() =>
                updateNativeWatchWork(
                  envelope.state,
                  consumerId,
                  required(request.dispositions, 'dispositions') as NativeWatchDisposition[],
                  at,
                ),
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
        const saved =
          envelope === stored.envelope ? stored : yield* writeNativeWatch(config, envelope, stored.revision);
        const inspected = yield* health(saved, at);
        const {pr: _pr, sources: _sources, metrics: _metrics, ...compact} = inspected;
        return {...compact, ...output};
      }),
    );
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
  runNativeWatchCommand(config, input).pipe(Effect.flatMap(value => from(() => assertNativeWatchOutput(value))));
