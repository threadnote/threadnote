import {it as effectIt} from '@effect/vitest';
import * as Array from 'effect/Array';
import * as Clock from 'effect/Clock';
import * as Crypto from 'effect/Crypto';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as PlatformError from 'effect/PlatformError';
import * as Path from 'effect/Path';
import * as EffectString from 'effect/String';
import {SystemInfo} from '@threadnote/platform/system';
import * as TestClock from 'effect/testing/TestClock';
import * as BunServices from '@effect/platform-bun/BunServices';
import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {
  CommandExecutor,
  CommandSpawnFailed,
  CommandTimedOut,
  type CommandExecutionError,
  type CommandOptions,
  type CommandResult,
} from '@threadnote/platform/command';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  acknowledgeNativeWatch,
  attachNativeWatchConsumer,
  initializeNativeWatch,
  recordNativeWatchDispositions,
  recordNativeWatchLifecycle,
  reconcileNativeWatch,
  relayNativeWatch,
} from '@threadnote/workflow-automations/watch';
import {provideTestLayer} from '../helpers/effect-layer.js';
import {
  decodeNativeWatchEnvelope,
  readNativeWatch,
  writeNativeWatch,
  withNativeWatchControlLock,
} from '../../src/workflow_automation/watch_store.js';
import {
  makeNativeWatchNotifier,
  maintainNativeWatchSubscription,
} from '../../src/workflow_automation/watch_notification.js';
import {
  nativeWatchNotice,
  nativeWatchWakeupSchema,
  stageNativeWatchNotification,
  consumeNativeWatchNotification,
} from '../../src/workflow_automation/watch_notification_state.js';
import * as Schema from 'effect/Schema';
import {runNativeWatch} from '../../src/workflow_automation/watch.js';
import {
  claimNativeWatchHostSession,
  type NativeWatchHostClaim,
} from '../../src/workflow_automation/watch_host_session.js';

const token = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const receipt = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const target = {host: 'codex' as const, executable: '/trusted/codex', threadId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc'};
const success = {exitCode: 0, stderr: '', stdout: `Queued message ${receipt} for thread ${target.threadId}.\n`};
const queueHelp =
  'Queue a message for an existing session\n\nUsage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>\n\nOptions:\n      --thread <THREAD>\n          Session UUID or exact session name\n      --message <TEXT>\n          Message text to queue\n';
const capable = {exitCode: 0, stderr: '', stdout: queueHelp};
const fixture = Effect.fn('test.watchNotification.fixture')(function* (events = 0, sharedUserHome?: string) {
  const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({prefix: 'native-watch-notification-'});
  const config: RuntimeConfig = {
    agentContextHome: home,
    account: 'local',
    agentId: 'test',
    user: 'tester',
    manifestPath: home + '/manifest.json',
  };
  let state = attachNativeWatchConsumer(
    initializeNativeWatch('watch-1', 'https://github.com/test/repo/pull/1', 0),
    {id: 'consumer', wakeupId: 'wakeup'},
    0,
  );
  for (let index = 0; index < events; index++)
    state = recordNativeWatchLifecycle(state, 'watcher_error', 'error-' + index, 0);
  const envelope = decodeNativeWatchEnvelope({
    format: 'threadnote-native-watch-runtime',
    version: 1,
    state,
    provider: {pages: []},
    stopRequested: false,
    collector: {token, pid: 123, startedAt: 0, lastSeenAt: 0, nextPollAt: 0, status: 'running', consecutiveErrors: 0},
    notification: {
      consumerId: 'consumer',
      wakeupId: 'wakeup',
      target,
      lastConsumerAt: 0,
      notifiedThrough: 0,
      outbox: null,
    },
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
  yield* writeNativeWatch(config, envelope, null);
  const read = () => readNativeWatch(config, 'watch-1').pipe(Effect.map(value => value!));
  const system = yield* SystemInfo;
  const userHome = sharedUserHome ?? home;
  const fresh = () =>
    makeNativeWatchNotifier(config, 'watch-1', token).pipe(
      Effect.provideService(SystemInfo, {...system, homeDirectory: userHome}),
    );
  const notifier = yield* fresh();
  return {config, read, dispatch: notifier.tick, drain: notifier.drain, fresh, envelope, userHome};
});
const commandLayer =
  <E, R>(
    execute: (
      executable: string,
      args: readonly string[],
      options?: CommandOptions,
    ) => Effect.Effect<CommandResult, E, R>,
  ) =>
  <A, E2, R2>(program: Effect.Effect<A, E2, R2>) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>();
      return yield* program.pipe(
        Effect.provideService(CommandExecutor, {
          execute: (executable, args, options) =>
            execute(executable, args, options).pipe(Effect.provide(context), Effect.orDie),
          executeStreaming: () => Effect.die(new Error('Unexpected streaming command')),
        }),
      );
    });
const arrive = Effect.fn('test.watchNotification.arrive')(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
  fields: Record<string, unknown> = {},
) {
  const stored = yield* f.read();
  const {attemptId, ...request} = {
    protocolVersion: 1,
    executorVersion: 1,
    action: 'watch',
    command: 'relay',
    watchId: 'watch-1',
    consumerId: 'consumer',
    wakeupId: 'wakeup',
    eventKey: stored.envelope.notification?.outbox?.key,
    attemptId: stored.envelope.notification?.outbox?.attemptId,
    ...fields,
  };
  return yield* runNativeWatch(f.config, {...request, ...(attemptId === undefined ? {} : {attemptId})});
});
const acknowledge = Effect.fn('test.watchNotification.acknowledge')(function* (
  f: Effect.Success<ReturnType<typeof fixture>>,
) {
  const stored = yield* f.read();
  const at = yield* Clock.currentTimeMillis;
  const relay = relayNativeWatch(stored.envelope.state, 'consumer', at);
  const state = acknowledgeNativeWatch(
    recordNativeWatchDispositions(
      relay.state,
      'consumer',
      relay.delivery!.id,
      Array.map(relay.delivery!.events, event => ({
        eventId: event.id,
        status: 'open' as const,
        reason: 'retained follow-up',
        evidence: 'fixture',
      })),
      at,
    ),
    'consumer',
    relay.delivery!.id,
    at,
  );
  yield* writeNativeWatch(f.config, {...stored.envelope, state}, stored.revision);
});
const provide = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(
    Effect.provideService(CommandExecutor, {
      execute: () => Effect.die(new Error('Unexpected host call')),
      executeStreaming: () => Effect.die(new Error('Unexpected streaming command')),
    }),
    provideTestLayer(Layer.mergeAll(BunServices.layer, SystemInfo.layer)),
  );

effectIt.effect('rejects unsupported Codex start and changed consumer bindings before any durable mutation', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1);
    const fs = yield* FileSystem.FileSystem;
    const statePath = f.config.agentContextHome + '/workflow-automations/native-watch-v1/watch-1.json';
    const original = yield* fs.readFileString(statePath);
    const changed = {...target, executable: '/unsupported/codex'};
    const failures: readonly Effect.Effect<CommandResult, CommandExecutionError>[] = [
      Effect.succeed({exitCode: 1, stderr: "error: unrecognized subcommand 'queue'", stdout: ''}),
      Effect.succeed({exitCode: 0, stderr: '', stdout: 'Usage: codex [OPTIONS] [PROMPT]\nCommands:\n  exec\n'}),
      Effect.succeed({
        ...capable,
        stdout: EffectString.replaceAll('--thread <THREAD>', '--target <THREAD>')(queueHelp),
      }),
      Effect.succeed({...capable, stdout: EffectString.replaceAll('--message <TEXT>', '--text <TEXT>')(queueHelp)}),
      Effect.fail(
        CommandSpawnFailed.make({
          executable: changed.executable,
          args: ['queue', '--help'],
          message: 'missing',
          cause: 'ENOENT',
        }),
      ),
      Effect.fail(
        CommandTimedOut.make({
          executable: changed.executable,
          args: ['queue', '--help'],
          message: 'timeout',
          timeoutMs: 5000,
        }),
      ),
    ];
    for (const command of ['start', 'consumer'])
      for (const response of failures) {
        const watchId = command === 'start' ? 'new-watch' : 'watch-1';
        let probes = 0;
        const result = yield* runNativeWatch(f.config, {
          protocolVersion: 1,
          executorVersion: 1,
          action: 'watch',
          command,
          watchId,
          pr: f.envelope.state.pr,
          consumerId: 'consumer',
          wakeupId: 'wakeup',
          wakeup: changed,
        }).pipe(
          Effect.provideService(CommandExecutor, {
            execute: (executable, args, options) => {
              probes++;
              expect(executable).toBe(changed.executable);
              expect(args).toEqual(['queue', '--help']);
              expect(options).toEqual({allowFailure: true, timeoutMs: 5000, maxOutputBytes: 16384});
              return response;
            },
            executeStreaming: () => Effect.die(new Error('Unexpected streaming command')),
          }),
          Effect.result,
        );
        expect(result).toMatchObject({
          failure: {code: 'host-queue-incompatible', message: expect.stringContaining(changed.executable)},
        });
        expect(probes).toBe(1);
        expect(yield* fs.readFileString(statePath)).toBe(original);
        expect(yield* readNativeWatch(f.config, 'new-watch')).toBeUndefined();
      }
  }).pipe(provide),
);

effectIt.effect.prop(
  'qualifies a changed Codex binding once across unchanged consumer renewals and relays',
  {renewals: Schema.Array(Schema.Literals(['explicit', 'implicit', 'relay'])).check(Schema.isBetweenLength(1, 8))},
  ({renewals}) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const stored = yield* f.read();
      yield* writeNativeWatch(f.config, {...stored.envelope, collector: null}, stored.revision);
      const changed = {...target, executable: '/capable/codex'};
      const request = {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: 'consumer',
        watchId: 'watch-1',
        consumerId: 'consumer',
        wakeupId: 'wakeup',
      };
      let probes = 0;
      const call = (fields: Record<string, unknown>) =>
        runNativeWatch(f.config, {...request, ...fields}).pipe(
          commandLayer((executable, args) => {
            probes++;
            expect(executable).toBe(changed.executable);
            expect(args).toEqual(['queue', '--help']);
            return Effect.succeed(capable);
          }),
        );
      yield* call({wakeup: changed});
      for (const kind of renewals) {
        yield* TestClock.adjust(1);
        yield* call(kind === 'explicit' ? {wakeup: changed} : kind === 'relay' ? {command: 'relay'} : {});
      }
      const after = yield* f.read();
      expect(probes).toBe(1);
      expect(after.envelope.notification?.target).toEqual(changed);
      expect(after.envelope.collector).toBeNull();
      expect(after.envelope.provider).toEqual(stored.envelope.provider);
      expect(after.envelope.state.events).toEqual(stored.envelope.state.events);
      expect(after.envelope.state.work).toEqual(stored.envelope.state.work);
    }).pipe(provide),
  {arbitrary: {runs: 20}},
);

effectIt.effect('checks new subscription owners and terminal starts but leaves Cursor admission unchanged', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    let stored = yield* f.read();
    yield* writeNativeWatch(
      f.config,
      {...stored.envelope, collector: null, state: {...stored.envelope.state, prState: 'closed'}},
      stored.revision,
    );
    const request = {
      protocolVersion: 1,
      executorVersion: 1,
      action: 'watch',
      command: 'start',
      watchId: 'watch-1',
      pr: f.envelope.state.pr,
      consumerId: 'consumer',
      wakeupId: 'new-wakeup',
      wakeup: target,
      takeover: true,
    };
    let probes = 0;
    const commands = commandLayer((executable, args) => {
      probes++;
      expect(executable).toBe(target.executable);
      expect(args).toEqual(['queue', '--help']);
      return Effect.succeed(capable);
    });
    yield* runNativeWatch(f.config, request).pipe(commands);
    expect(probes).toBe(1);
    yield* runNativeWatch(f.config, request).pipe(commands);
    expect(probes).toBe(1);
    yield* runNativeWatch(f.config, {...request, wakeup: {...target, threadId: receipt}}).pipe(commands);
    expect(probes).toBe(2);
    stored = yield* f.read();
    expect(stored.envelope.collector).toBeNull();
    expect(stored.envelope.notification?.wakeupId).toBe('new-wakeup');
    yield* runNativeWatch(f.config, {...request, command: 'consumer', wakeup: cursorTarget});
    expect((yield* f.read()).envelope.notification?.target).toEqual(cursorTarget);
  }).pipe(provide),
);

effectIt.effect('refuses a skipped-probe binding that changed concurrently before the control lock', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const fs = yield* FileSystem.FileSystem;
    const context = yield* Effect.context<Crypto.Crypto | Path.Path>();
    const stored = yield* f.read();
    const changed = {
      ...stored.envelope,
      notification: {...stored.envelope.notification!, target: {...target, threadId: receipt}},
    };
    let raced = false;
    const intercepted = FileSystem.FileSystem.of({
      ...fs,
      readFileString: (path, options) =>
        Effect.gen(function* () {
          const bytes = yield* fs.readFileString(path, options);
          if (!raced && EffectString.endsWith('/watch-1.json')(EffectString.replaceAll('\\', '/')(path))) {
            raced = true;
            yield* writeNativeWatch(f.config, changed, stored.revision).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provide(context),
              Effect.orDie,
            );
          }
          return bytes;
        }),
    });
    expect(
      yield* runNativeWatch(f.config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: 'consumer',
        watchId: 'watch-1',
        consumerId: 'consumer',
        wakeupId: 'wakeup',
        wakeup: target,
      }).pipe(Effect.provideService(FileSystem.FileSystem, intercepted), Effect.result),
    ).toMatchObject({failure: {code: 'watch-state-conflict'}});
    expect(raced).toBe(true);
    expect((yield* f.read()).envelope).toEqual(changed);
  }).pipe(provide),
);

describe('native watch notification transport', () => {
  it('bounds ID-only messages and rejects executable injection configuration', () => {
    for (const executable of ['codex', '/bin/sh', '/tmp/codex.cmd', '/tmp/codex\n']) {
      const input: unknown = {...target, executable};
      expect(() => Schema.decodeUnknownSync(nativeWatchWakeupSchema)(input)).toThrow();
    }
    const pending = {
      key: 'watch-1:1:3',
      first: 1,
      last: 3,
      createdAt: 0,
      attempts: 0,
      nextAttemptAt: 0,
      status: 'pending' as const,
    };
    expect(
      nativeWatchNotice(
        {home: '/private/home', watchId: 'watch-1', consumerId: 'consumer', wakeupId: 'wakeup'},
        pending,
      ),
    ).not.toContain('https:');
    expect(
      nativeWatchNotice(
        {home: '/private/home', watchId: 'watch-1', consumerId: 'consumer', wakeupId: 'wakeup'},
        pending,
      ),
    ).toMatch(/^Threadnote watch event\. Route=/u);
    expect(
      nativeWatchNotice(
        {home: '/private/home', watchId: 'watch-1', consumerId: 'consumer', wakeupId: 'wakeup'},
        pending,
      ).length,
    ).toBeLessThan(512);
  });
  it('stages each durable range deterministically without mutating state', () => {
    fc.assert(
      fc.property(fc.integer({min: 0, max: 30}), fc.nat({max: 100_000}), (count, at) => {
        let state = attachNativeWatchConsumer(
          initializeNativeWatch('watch-1', 'https://github.com/test/repo/pull/1', 0),
          {id: 'consumer', wakeupId: 'wakeup'},
          0,
        );
        for (let index = 0; index < count; index++)
          state = recordNativeWatchLifecycle(state, 'watcher_error', 'error-' + index, 0);
        const acknowledged = at % (count + 1);
        if (acknowledged) {
          const relay = relayNativeWatch(state, 'consumer', 0, acknowledged);
          const dispositions = Array.map(relay.delivery!.events, event => ({
            eventId: event.id,
            status: 'resolved' as const,
            reason: 'property consumed',
            evidence: 'fixture',
          }));
          state = acknowledgeNativeWatch(
            recordNativeWatchDispositions(relay.state, 'consumer', relay.delivery!.id, dispositions, 0),
            'consumer',
            relay.delivery!.id,
            0,
          );
        }
        const original = JSON.stringify(state);
        const notification = {
          consumerId: 'consumer',
          wakeupId: 'wakeup',
          target,
          lastConsumerAt: 0,
          notifiedThrough: 0,
          outbox: null,
        };
        const staged = stageNativeWatchNotification(notification, state, at);
        expect(staged.outbox?.last ?? acknowledged).toBe(count);
        expect(staged.notifiedThrough).toBe(acknowledged);
        if (staged.outbox) expect(staged.outbox.first).toBe(acknowledged + 1);
        expect(stageNativeWatchNotification(staged, state, at + 1)).toBe(staged);
        expect(stageNativeWatchNotification({...notification, notifiedThrough: count}, state, at)).toEqual({
          ...notification,
          notifiedThrough: count,
        });
        expect(JSON.stringify(state)).toBe(original);
      }),
      {numRuns: 30},
    );
  });
});

effectIt.effect('idle sweeps perform zero host calls and do not mutate the envelope', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const before = yield* f.read();
    let calls = 0;
    yield* Effect.forEach(globalThis.Array.from({length: 100}), () => f.dispatch()).pipe(
      commandLayer(() => {
        calls++;
        return Effect.succeed(success);
      }),
    );
    expect(calls).toBe(0);
    expect((yield* f.read()).revision).toBe(before.revision);
  }).pipe(provide),
);

effectIt.effect('coalesces new events, durably records the host receipt, and never repeats unchanged open work', () =>
  Effect.gen(function* () {
    const f = yield* fixture(3);
    const calls: string[][] = [];
    yield* f.dispatch().pipe(
      commandLayer((executable, args) => {
        expect(executable).toBe(target.executable);
        calls.push([...args]);
        return Effect.succeed(success);
      }),
    );
    const inspect = () =>
      runNativeWatch(f.config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: 'inspect',
        watchId: 'watch-1',
      });
    expect(yield* inspect()).toMatchObject({
      consumer: {wakeupVerification: 'native-host-receipt-recorded'},
      notification: {status: 'queued', receipt, consumedThrough: 0, notifiedThrough: 0, lastReceipt: null},
    });
    yield* f.dispatch();
    yield* arrive(f);
    expect(yield* inspect()).toMatchObject({
      consumer: {wakeupVerification: 'native-host-receipt-recorded'},
      notification: {status: 'queued', receipt, consumedThrough: 3, notifiedThrough: 0, lastReceipt: null},
    });
    yield* f.dispatch();
    const queued = yield* f.read();
    expect(queued.envelope.notification).toMatchObject({
      notifiedThrough: 0,
      outbox: {first: 1, last: 3, status: 'queued', receipt, attempts: 1},
    });
    const relay = relayNativeWatch(queued.envelope.state, 'consumer', 0);
    const dispositions = Array.map(relay.delivery!.events, event => ({
      eventId: event.id,
      status: 'open' as const,
      reason: 'requires follow-up',
      evidence: 'fixture',
    }));
    const state = acknowledgeNativeWatch(
      recordNativeWatchDispositions(relay.state, 'consumer', relay.delivery!.id, dispositions, 0),
      'consumer',
      relay.delivery!.id,
      0,
    );
    yield* writeNativeWatch(f.config, {...queued.envelope, state}, queued.revision);
    yield* Effect.forEach(globalThis.Array.from({length: 20}), () => f.dispatch()).pipe(
      commandLayer(() => Effect.die(new Error('Unexpected host call'))),
    );
    const after = yield* f.read();
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 4)).toEqual(['queue', '--thread', target.threadId, '--message']);
    expect(calls[0][4]).toContain(
      JSON.stringify({
        home: f.config.agentContextHome,
        watchId: 'watch-1',
        consumerId: 'consumer',
        wakeupId: 'wakeup',
        eventKey: 'watch-1:1:3',
        attemptId: queued.envelope.notification!.outbox!.attemptId,
      }),
    );
    expect(after.envelope.notification).toMatchObject({notifiedThrough: 3, outbox: null, lastReceipt: {receipt}});
    expect(yield* inspect()).toMatchObject({
      consumer: {wakeupVerification: 'native-host-receipt-recorded'},
      notification: {status: 'idle', receipt: null, lastReceipt: {receipt}},
    });
    expect(Array.filter(after.envelope.state.work, item => item.status === 'open')).toHaveLength(3);
  }).pipe(provide),
);

effectIt.effect(
  'host completion preserves concurrent ACK and newly appended events without holding the control lock',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(1);
      yield* f.dispatch().pipe(
        commandLayer(() =>
          withNativeWatchControlLock(
            f.config,
            'watch-1',
            Effect.gen(function* () {
              const stored = yield* f.read();
              const relay = relayNativeWatch(stored.envelope.state, 'consumer', 0);
              const disposition = Array.map(relay.delivery!.events, event => ({
                eventId: event.id,
                status: 'open' as const,
                reason: 'follow-up',
                evidence: 'fixture',
              }));
              const ack = acknowledgeNativeWatch(
                recordNativeWatchDispositions(relay.state, 'consumer', relay.delivery!.id, disposition, 0),
                'consumer',
                relay.delivery!.id,
                0,
              );
              const state = recordNativeWatchLifecycle(ack, 'watcher_stopped', 'stop-requested', 0);
              const notification = consumeNativeWatchNotification(stored.envelope.notification!, relay.state, {
                consumerId: 'consumer',
                wakeupId: 'wakeup',
                eventKey: stored.envelope.notification!.outbox!.key,
                attemptId: stored.envelope.notification!.outbox!.attemptId!,
              });
              yield* writeNativeWatch(f.config, {...stored.envelope, state, notification}, stored.revision);
              return success;
            }),
          ),
        ),
      );
      yield* f.dispatch();
      const stored = yield* f.read();
      expect(stored.envelope.state.acknowledged).toBe(1);
      expect(Array.map(stored.envelope.state.events, event => event.sequence)).toEqual([2]);
      expect(stored.envelope.state.work).toHaveLength(1);
      let calls = 0;
      yield* f.drain().pipe(
        commandLayer(() => {
          calls++;
          return Effect.succeed(success);
        }),
      );
      expect(calls).toBe(1);
      expect((yield* f.read()).envelope.notification).toMatchObject({
        notifiedThrough: 1,
        outbox: {status: 'queued', last: 2},
      });
    }).pipe(provide),
);

effectIt.effect('successive CI failures share one queued wake through early ACK, arrival and backlog ACK', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const queue: string[] = [];
    const dispatch = f.dispatch().pipe(
      commandLayer((_executable, args) => {
        queue.push(args[4]);
        return Effect.succeed(success);
      }),
    );
    const head = EffectString.repeat(40)('a');
    for (let failed = 1; failed <= 3; failed++) {
      const stored = yield* f.read();
      const state = reconcileNativeWatch(stored.envelope.state, {
        head,
        startedHead: head,
        state: 'open',
        at: failed,
        sources: [
          {
            source: 'checks',
            complete: true,
            head,
            at: failed,
            items: globalThis.Array.from({length: failed}, (_, index) => ({
              id: 'job-' + index,
              version: EffectString.repeat(64)('b'),
              kind: 'ci_error' as const,
              bootstrap: true,
              head,
            })),
          },
        ],
        ci: {
          head,
          complete: false,
          count: 4,
          pending: 4 - failed,
          failed,
          version: EffectString.repeat(64)(String(failed)),
        },
      });
      yield* writeNativeWatch(f.config, {...stored.envelope, state}, stored.revision);
      yield* dispatch;
      if (failed === 1) yield* acknowledge(f);
      yield* dispatch;
      yield* (yield* f.fresh()).drain();
      expect(queue).toHaveLength(1);
      expect((yield* f.read()).envelope.state.nextSequence).toBe(state.nextSequence);
    }
    const beforeArrival = yield* f.read();
    expect(Array.filter(beforeArrival.envelope.state.events, event => event.kind === 'ci_error')).toHaveLength(2);
    queue.shift();
    yield* arrive(f);
    const claimed = yield* f.read();
    expect(claimed.envelope.state.acknowledged).toBe(beforeArrival.envelope.state.acknowledged);
    expect(claimed.envelope.state.work).toEqual(beforeArrival.envelope.state.work);
    expect(claimed.envelope.notification?.outbox?.consumedThrough).toBe(claimed.envelope.state.nextSequence - 1);
    yield* dispatch;
    expect((yield* f.read()).envelope.notification?.outbox?.status).toBe('queued');
    expect(queue).toHaveLength(0);
    yield* acknowledge(f);
    yield* dispatch;
    const finished = yield* f.read();
    expect(finished.envelope.notification?.outbox).toBeNull();
    expect(finished.envelope.state.work.length).toBeGreaterThanOrEqual(3);
    const state = recordNativeWatchLifecycle(finished.envelope.state, 'watcher_stopped', 'terminal', 0);
    yield* writeNativeWatch(f.config, {...finished.envelope, state, stopRequested: true}, finished.revision);
    yield* f.drain().pipe(
      commandLayer((_executable, args) => {
        queue.push(args[4]);
        return Effect.succeed(success);
      }),
    );
    expect(queue).toHaveLength(1);
    const newer = yield* f.read();
    yield* arrive(f, {eventKey: beforeArrival.envelope.notification!.outbox!.key});
    yield* arrive(f, {eventKey: 'another-watch:1:1'});
    yield* arrive(f, {wakeupId: 'different-wakeup'});
    expect((yield* f.read()).envelope.notification?.outbox).toEqual(newer.envelope.notification?.outbox);
    const takeover = yield* runNativeWatch(f.config, {
      protocolVersion: 1,
      executorVersion: 1,
      action: 'watch',
      command: 'consumer',
      watchId: 'watch-1',
      consumerId: 'consumer',
      wakeupId: 'new-wakeup',
      takeover: true,
      wakeup: target,
    }).pipe(
      commandLayer(() => Effect.succeed(capable)),
      Effect.result,
    );
    expect(takeover).toMatchObject({failure: {code: 'wakeup-recovery-required'}});
    yield* (yield* f.fresh()).drain();
    expect(queue).toHaveLength(1);
  }).pipe(provide),
);

effectIt.effect('actual arrival before receipt survives finish without upgrading ambiguous delivery', () =>
  Effect.gen(function* () {
    for (const accepted of [true, false]) {
      const f = yield* fixture(1);
      yield* f.dispatch().pipe(
        commandLayer(() =>
          Effect.gen(function* () {
            yield* arrive(f);
            const arrival = yield* f.read();
            expect(arrival.envelope.notification?.outbox).toMatchObject({status: 'sending', consumedThrough: 1});
            expect(arrival.envelope.state.acknowledged).toBe(0);
            expect(arrival.envelope.state.work).toHaveLength(0);
            yield* acknowledge(f);
            const stored = yield* f.read();
            const state = recordNativeWatchLifecycle(stored.envelope.state, 'watcher_error', 'later', 0);
            yield* writeNativeWatch(f.config, {...stored.envelope, state}, stored.revision);
            return accepted ? success : {...success, stdout: 'lost receipt'};
          }),
        ),
      );
      const finished = yield* f.read();
      expect(finished.envelope.notification?.outbox).toMatchObject({
        status: accepted ? 'queued' : 'failed',
        consumedThrough: 1,
      });
      yield* arrive(f);
      expect((yield* f.read()).envelope.notification?.outbox?.consumedThrough).toBe(1);
      yield* (yield* f.fresh()).drain().pipe(commandLayer(() => Effect.succeed(success)));
      const after = yield* f.read();
      expect(after.envelope.notification?.outbox).toMatchObject(
        accepted
          ? {status: 'queued', first: 2}
          : {status: 'failed', error: 'host-delivery-ambiguous', consumedThrough: 1},
      );
    }
  }).pipe(provide),
);

effectIt.effect('fences recovered attempts of the same range and reads legacy accepted notices without replay', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1);
    yield* f.dispatch().pipe(commandLayer(() => Effect.succeed({...success, stdout: 'lost receipt'})));
    const ambiguous = yield* f.read();
    const old = ambiguous.envelope.notification!.outbox!;
    yield* arrive(f);
    expect((yield* f.read()).envelope.notification?.outbox?.status).toBe('failed');
    yield* runNativeWatch(f.config, {
      protocolVersion: 1,
      executorVersion: 1,
      action: 'watch',
      command: 'consumer',
      watchId: 'watch-1',
      consumerId: 'consumer',
      wakeupId: 'wakeup',
      recoverWakeup: true,
    });
    yield* f.dispatch().pipe(commandLayer(() => Effect.succeed(success)));
    const recovered = yield* f.read();
    const current = recovered.envelope.notification!.outbox!;
    expect(current.key).toBe(old.key);
    expect(current.attemptId).not.toBe(old.attemptId);
    expect(current.consumedThrough).toBe(0);
    yield* arrive(f, {eventKey: old.key, attemptId: old.attemptId});
    yield* arrive(f, {eventKey: old.key, attemptId: undefined});
    yield* arrive(f, {consumerId: 'different-owner'}).pipe(Effect.result);
    expect((yield* f.read()).envelope.notification?.outbox).toEqual(current);
    yield* arrive(f);
    yield* acknowledge(f);
    yield* f.dispatch();
    expect((yield* f.read()).envelope.notification?.outbox).toBeNull();

    const legacy = yield* fixture(1);
    yield* legacy.dispatch().pipe(commandLayer(() => Effect.succeed(success)));
    const stored = yield* legacy.read();
    const {consumedThrough: _consumedThrough, ...accepted} = stored.envelope.notification!.outbox!;
    yield* writeNativeWatch(
      legacy.config,
      {...stored.envelope, notification: {...stored.envelope.notification!, outbox: accepted}},
      stored.revision,
    );
    yield* acknowledge(legacy);
    yield* (yield* legacy.fresh()).drain();
    expect((yield* legacy.read()).envelope.notification?.outbox).toEqual(accepted);
    yield* arrive(legacy, {attemptId: undefined});
    yield* (yield* legacy.fresh()).drain();
    expect((yield* legacy.read()).envelope.notification).toMatchObject({
      notifiedThrough: 1,
      outbox: null,
      lastReceipt: {receipt, attemptId: accepted.attemptId},
    });
  }).pipe(provide),
);

effectIt.effect.prop(
  'conserves events and queues at most one wake across arrival, ACK, append and restart interleavings',
  {steps: Schema.Array(Schema.Literals(['append', 'ack', 'arrive', 'restart'])).check(Schema.isBetweenLength(1, 12))},
  ({steps}) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      let notifier = yield* f.fresh();
      let queued = false;
      let total = 0;
      for (const step of steps) {
        const before = yield* f.read();
        if (step === 'append') {
          const state = recordNativeWatchLifecycle(before.envelope.state, 'watcher_error', 'error-' + total++, 0);
          yield* writeNativeWatch(f.config, {...before.envelope, state}, before.revision);
        } else if (step === 'ack' && before.envelope.state.events.length) yield* acknowledge(f);
        else if (step === 'arrive' && queued) {
          queued = false;
          yield* arrive(f);
        } else if (step === 'restart') notifier = yield* f.fresh();
        yield* notifier.drain().pipe(
          commandLayer(() => {
            expect(queued).toBe(false);
            queued = true;
            return Effect.succeed(success);
          }),
        );
        const after = yield* f.read();
        expect(after.envelope.state.nextSequence - 1).toBe(total);
        expect(after.envelope.state.acknowledged + after.envelope.state.events.length).toBe(total);
        expect(after.envelope.state.work.length).toBe(after.envelope.state.acknowledged);
      }
    }).pipe(provide),
  {arbitrary: {runs: 20}},
);

effectIt.effect('terminal notice survives lease expiry and explicit same-owner renewal before arrival', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1);
    yield* f.dispatch().pipe(commandLayer(() => Effect.succeed(success)));
    const queued = yield* f.read();
    const head = EffectString.repeat(40)('a');
    const state = reconcileNativeWatch(queued.envelope.state, {
      head,
      startedHead: head,
      state: 'merged',
      at: 0,
      sources: [],
      ci: {head, complete: false, count: 0, pending: 0, failed: 0, version: EffectString.repeat(64)('a')},
    });
    yield* writeNativeWatch(
      f.config,
      {...queued.envelope, state, collector: {...queued.envelope.collector!, status: 'terminal', reason: 'merged'}},
      queued.revision,
    );
    yield* TestClock.adjust(state.consumer!.leaseUntil + 1);
    expect(yield* arrive(f).pipe(Effect.result)).toMatchObject({failure: {code: 'invalid-watch'}});
    const renew = () =>
      runNativeWatch(f.config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: 'consumer',
        watchId: 'watch-1',
        consumerId: 'consumer',
        wakeupId: 'wakeup',
      });
    yield* renew();
    const renewed = yield* f.read();
    expect(renewed.envelope.notification?.outbox).toEqual(queued.envelope.notification?.outbox);
    expect(renewed.envelope.state.events).toEqual(state.events);
    expect(renewed.envelope.state.consumer).toMatchObject({id: 'consumer', wakeupId: 'wakeup'});
    yield* arrive(f);
    yield* acknowledge(f);
    yield* renew();
    const finished = yield* f.read();
    expect(finished.envelope.notification).toMatchObject({outbox: null, lastReceipt: {receipt}});
    expect(finished.envelope.state.events).toHaveLength(0);
    expect(finished.envelope.state.work.length).toBeGreaterThan(0);
  }).pipe(provide),
);

effectIt.effect('Codex crash ambiguity and lost receipts never automatically repeat an unchanged event', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1);
    const stored = yield* f.read();
    const notification = stageNativeWatchNotification(stored.envelope.notification!, stored.envelope.state, 0);
    yield* writeNativeWatch(
      f.config,
      {
        ...stored.envelope,
        notification: {
          ...notification,
          outbox: {
            ...notification.outbox!,
            attempts: 1,
            status: 'sending',
            attemptId: receipt,
            collectorToken: token,
            nextAttemptAt: 0,
          },
        },
      },
      stored.revision,
    );
    yield* f.dispatch();
    yield* TestClock.adjust(100_000);
    yield* f.dispatch();
    expect((yield* f.read()).envelope.notification).toMatchObject({
      notifiedThrough: 0,
      outbox: {status: 'failed', error: 'host-delivery-ambiguous'},
    });
    const ambiguous = yield* f.read();
    yield* writeNativeWatch(
      f.config,
      {...ambiguous.envelope, notification: {...ambiguous.envelope.notification!, recoveryRequested: true}},
      ambiguous.revision,
    );
    let calls = 0;
    const dispatch = f.dispatch().pipe(
      commandLayer(() => {
        calls++;
        return Effect.succeed({...success, stdout: 'accepted, receipt unavailable'});
      }),
    );
    yield* dispatch;
    yield* TestClock.adjust(100_000);
    yield* dispatch;
    expect(calls).toBe(1);
    expect((yield* f.read()).envelope.state.events).toEqual(stored.envelope.state.events);
  }).pipe(provide),
);

effectIt.effect(
  'ACK before dispatch or explicit recovery suppresses host calls while retaining accepted receipts',
  () =>
    Effect.gen(function* () {
      for (const prior of ['none', 'ambiguous', 'accepted']) {
        const f = yield* fixture(1);
        if (prior === 'accepted') yield* f.dispatch().pipe(commandLayer(() => Effect.succeed(success)));
        else if (prior === 'ambiguous')
          yield* f.dispatch().pipe(commandLayer(() => Effect.succeed({...success, stdout: 'lost receipt'})));
        const stored = yield* f.read();
        const relay = relayNativeWatch(stored.envelope.state, 'consumer', 0);
        const dispositions = Array.map(relay.delivery!.events, event => ({
          eventId: event.id,
          status: 'resolved' as const,
          reason: 'done',
          evidence: 'fixture',
        }));
        const state = acknowledgeNativeWatch(
          recordNativeWatchDispositions(relay.state, 'consumer', relay.delivery!.id, dispositions, 0),
          'consumer',
          relay.delivery!.id,
          0,
        );
        yield* writeNativeWatch(
          f.config,
          {
            ...stored.envelope,
            state,
            notification: {...stored.envelope.notification!, recoveryRequested: prior === 'ambiguous'},
          },
          stored.revision,
        );
        yield* f.dispatch();
        const after = yield* f.read();
        expect(after.envelope.notification).toMatchObject(
          prior === 'accepted'
            ? {notifiedThrough: 0, outbox: {status: 'queued', receipt}}
            : {notifiedThrough: 1, outbox: null},
        );
      }
    }).pipe(provide),
);

const cursorTarget = {
  host: 'cursor-cli' as const,
  executable: '/trusted/agent',
  sessionId: target.threadId,
  workspace: '/trusted/workspace',
  exclusiveSession: true as const,
};
const cursorReply = {
  ...success,
  stdout: JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: cursorTarget.sessionId,
    result: 'fixture completion',
  }),
};
const useCursor = Effect.fn('test.watchNotification.cursor')(function* (f: Effect.Success<ReturnType<typeof fixture>>) {
  const stored = yield* f.read();
  yield* writeNativeWatch(
    f.config,
    {...stored.envelope, notification: {...stored.envelope.notification!, target: cursorTarget}},
    stored.revision,
  );
});

effectIt.effect(
  'runs one exclusive Cursor continuation asynchronously and validates its exact completion session',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(1);
      yield* useCursor(f);
      const started = yield* Deferred.make<void>();
      const completion = yield* Deferred.make<CommandResult>();
      let calls = 0;
      const adapter = commandLayer((executable, args, options) =>
        Effect.gen(function* () {
          calls++;
          expect(options?.timeoutMs).toBe(0);
          expect(executable).toBe(cursorTarget.executable);
          expect(args.slice(0, 7)).toEqual([
            '--print',
            '--resume',
            cursorTarget.sessionId,
            '--workspace',
            cursorTarget.workspace,
            '--output-format',
            'json',
          ]);
          expect(args).not.toContain('--force');
          yield* Deferred.succeed(started, undefined);
          return yield* Deferred.await(completion);
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* f.dispatch().pipe(adapter);
          yield* Deferred.await(started);
          // Local probes and new durable events proceed while the continuation is running.
          const expired = yield* f.read();
          yield* writeNativeWatch(
            f.config,
            {
              ...expired.envelope,
              notification: {
                ...expired.envelope.notification!,
                outbox: {...expired.envelope.notification!.outbox!, nextAttemptAt: 0},
              },
            },
            expired.revision,
          );
          yield* f.dispatch().pipe(adapter);
          expect(calls).toBe(1);
          const running = yield* f.read();
          expect(running.envelope.notification?.outbox?.status).toBe('sending');
          const state = recordNativeWatchLifecycle(
            running.envelope.state,
            'watcher_stopped',
            'terminal-during-repair',
            120_000,
          );
          yield* writeNativeWatch(f.config, {...running.envelope, state}, running.revision);
          yield* Deferred.succeed(completion, cursorReply);
          // Drain joins completion through durable state rather than issuing a second concurrent continuation.
          yield* f.drain().pipe(adapter);
          expect(calls).toBe(2);
        }),
      );
      expect((yield* f.read()).envelope.notification).toMatchObject({
        notifiedThrough: 2,
        outbox: null,
        lastReceipt: {kind: 'cli-session-completed', receipt: cursorTarget.sessionId},
      });
    }).pipe(provide, TestClock.withLive),
);

effectIt.effect('Cursor scope interruption cleans up its owned command and never automatically replays ambiguity', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1);
    yield* useCursor(f);
    const started = yield* Deferred.make<void>();
    let cleaned = false;
    let calls = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* f.dispatch().pipe(
          commandLayer(() =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                calls++;
              }),
              () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
              () =>
                Effect.sync(() => {
                  cleaned = true;
                }),
            ),
          ),
        );
        yield* Deferred.await(started);
      }),
    );
    expect(cleaned).toBe(true);
    expect((yield* f.read()).envelope.notification?.outbox).toMatchObject({
      status: 'failed',
      error: 'host-delivery-ambiguous',
      attempts: 1,
    });
    yield* TestClock.adjust(300_000);
    yield* (yield* f.fresh()).tick();
    expect(calls).toBe(1);
  }).pipe(provide),
);

effectIt.effect('refuses mismatched or unsuccessful Cursor completion receipts without claiming delivery', () =>
  Effect.gen(function* () {
    for (const response of [
      {type: 'result', subtype: 'success', is_error: false, session_id: receipt},
      {type: 'result', subtype: 'error', is_error: true, session_id: cursorTarget.sessionId},
    ]) {
      const f = yield* fixture(1);
      yield* useCursor(f);
      yield* f.drain().pipe(
        commandLayer(() => Effect.succeed({...success, stdout: JSON.stringify(response)})),
        TestClock.withLive,
      );
      expect((yield* f.read()).envelope.notification).toMatchObject({
        notifiedThrough: 0,
        outbox: {status: 'failed', error: 'host-delivery-ambiguous', attempts: 1},
      });
    }
  }).pipe(provide),
);

effectIt.effect('native event subscription maintains exclusive ownership while legacy leases still expire', () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* TestClock.adjust(8 * 60_000);
    yield* maintainNativeWatchSubscription(f.config, 'watch-1', token);
    const maintained = yield* f.read();
    expect(maintained.envelope.state.consumer).toMatchObject({
      id: 'consumer',
      lastSeenAt: 8 * 60_000,
      leaseUntil: 23 * 60_000,
    });
    expect(maintained.envelope.notification?.lastConsumerAt).toBe(0);
    expect(() =>
      attachNativeWatchConsumer(
        maintained.envelope.state,
        {id: 'other-consumer', wakeupId: 'other-wakeup'},
        16 * 60_000,
        {takeover: true},
      ),
    ).toThrow();
    const {notification: _subscription, ...legacy} = maintained.envelope;
    yield* writeNativeWatch(f.config, legacy, maintained.revision);
    yield* TestClock.adjust(16 * 60_000);
    yield* maintainNativeWatchSubscription(f.config, 'watch-1', token);
    const expired = yield* f.read();
    expect(expired.envelope.state.consumer?.leaseUntil).toBe(23 * 60_000);
    expect(() => relayNativeWatch(expired.envelope.state, 'consumer', 24 * 60_000)).toThrow();
    expect(
      attachNativeWatchConsumer(expired.envelope.state, {id: 'other-consumer', wakeupId: 'other-wakeup'}, 24 * 60_000, {
        takeover: true,
      }).consumer?.id,
    ).toBe('other-consumer');
  }).pipe(provide),
);

effectIt.effect('interrupting a real Cursor child scope reaps its owned PID and preserves ambiguous delivery', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1);
    const fs = yield* FileSystem.FileSystem;
    const system = yield* SystemInfo;
    const entrypoint = f.config.agentContextHome + '/fake-agent.ts';
    const executable = f.config.agentContextHome + (process.platform === 'win32' ? '/agent.exe' : '/agent');
    const pidFile = f.config.agentContextHome + '/owned-child-pid';
    yield* fs.writeFileString(
      entrypoint,
      `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const built = yield* Effect.tryPromise(() =>
      Bun.build({entrypoints: [entrypoint], compile: {outfile: executable}}),
    );
    expect(built.success).toBe(true);
    const stored = yield* f.read();
    yield* writeNativeWatch(
      f.config,
      {
        ...stored.envelope,
        notification: {
          ...stored.envelope.notification!,
          target: {...cursorTarget, executable, workspace: f.config.agentContextHome},
        },
      },
      stored.revision,
    );
    let pid = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* f.dispatch();
        const deadline = (yield* Clock.currentTimeMillis) + 5000;
        while (!(yield* fs.exists(pidFile)) && (yield* Clock.currentTimeMillis) < deadline) yield* Effect.sleep(20);
        expect(yield* fs.exists(pidFile)).toBe(true);
        pid = Number(yield* fs.readFileString(pidFile));
        expect(system.isProcessRunning(pid)).toBe(true);
      }),
    );
    const deadline = (yield* Clock.currentTimeMillis) + 5000;
    while (system.isProcessRunning(pid) && (yield* Clock.currentTimeMillis) < deadline) yield* Effect.sleep(20);
    expect(system.isProcessRunning(pid)).toBe(false);
    expect((yield* f.read()).envelope.notification?.outbox).toMatchObject({
      status: 'failed',
      error: 'host-delivery-ambiguous',
    });
  }).pipe(
    provideTestLayer(
      Layer.mergeAll(
        BunServices.layer,
        SystemInfo.layer,
        CommandExecutor.layer.pipe(Layer.provide(Layer.mergeAll(BunServices.layer, SystemInfo.layer))),
      ),
    ),
    TestClock.withLive,
  ),
);

effectIt.effect('a new collector refuses to replay a crash-ambiguous Cursor continuation', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1);
    yield* useCursor(f);
    const stored = yield* f.read();
    const notification = stageNativeWatchNotification(stored.envelope.notification!, stored.envelope.state, 0);
    yield* writeNativeWatch(
      f.config,
      {
        ...stored.envelope,
        notification: {
          ...notification,
          outbox: {
            ...notification.outbox!,
            attempts: 1,
            status: 'sending',
            attemptId: receipt,
            collectorToken: 'dddddddd-dddd-4ddd-dddd-dddddddddddd',
            nextAttemptAt: 0,
          },
        },
      },
      stored.revision,
    );
    yield* f.dispatch();
    yield* TestClock.adjust(60_000);
    yield* f.dispatch();
    expect((yield* f.read()).envelope.notification?.outbox).toMatchObject({
      status: 'failed',
      error: 'host-delivery-ambiguous',
      attempts: 1,
    });
  }).pipe(provide),
);

effectIt.effect(
  'terminal recovery classifies a same-token orphan without waiting and needs explicit host recovery',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(1);
      yield* useCursor(f);
      const stored = yield* f.read();
      const notification = stageNativeWatchNotification(stored.envelope.notification!, stored.envelope.state, 0);
      yield* writeNativeWatch(
        f.config,
        {
          ...stored.envelope,
          state: {...stored.envelope.state, prState: 'merged'},
          collector: {...stored.envelope.collector!, status: 'terminal', pid: 0},
          notification: {
            ...notification,
            outbox: {
              ...notification.outbox!,
              status: 'sending',
              attempts: 1,
              attemptId: receipt,
              collectorToken: token,
            },
          },
        },
        stored.revision,
      );
      const system = yield* SystemInfo;
      const request = {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: 'consumer',
        watchId: 'watch-1',
        consumerId: 'consumer',
        wakeupId: 'wakeup',
      };
      const call = (recoverWakeup: boolean) =>
        runNativeWatch(f.config, {...request, recoverWakeup}).pipe(
          Effect.provideService(SystemInfo, {...system, homeDirectory: f.userHome}),
        );
      yield* call(false);
      expect((yield* f.read()).envelope.notification?.outbox).toMatchObject({
        status: 'failed',
        error: 'host-delivery-ambiguous',
      });
      let calls = 0;
      yield* call(true).pipe(
        commandLayer(() => {
          calls++;
          return Effect.succeed(cursorReply);
        }),
      );
      const after = yield* f.read();
      expect(calls).toBe(1);
      expect(after.envelope.notification).toMatchObject({notifiedThrough: 1, outbox: null});
      expect(after.envelope.collector).toEqual({...stored.envelope.collector, status: 'terminal', pid: 0});
    }).pipe(provide, TestClock.withLive),
);

effectIt.effect(
  'Cursor session claims exclude two private watch homes and case/executable aliases, and remain sticky after interruption',
  () =>
    Effect.gen(function* () {
      const sharedHome = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({prefix: 'native-host-shared-'});
      const first = yield* fixture(1, sharedHome);
      const second = yield* fixture(1, sharedHome);
      yield* useCursor(first);
      yield* useCursor(second);
      const initial = yield* second.read();
      yield* writeNativeWatch(
        second.config,
        {
          ...initial.envelope,
          notification: {
            ...initial.envelope.notification!,
            target: {
              ...cursorTarget,
              executable: '/trusted/cursor-agent',
              sessionId: EffectString.toUpperCase(cursorTarget.sessionId),
            },
          },
        },
        initial.revision,
      );
      const started = yield* Deferred.make<void>();
      let calls = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* first.dispatch().pipe(
            commandLayer(() => {
              calls++;
              return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
            }),
          );
          yield* Deferred.await(started);
          yield* second.drain();
          expect((yield* second.read()).envelope.notification?.outbox).toMatchObject({
            status: 'failed',
            error: 'host-session-owned',
          });
          expect(calls).toBe(1);
        }),
      );
      // Recovering the short file lock or a parent process never discards the separate sticky claim.
      const denied = yield* second.read();
      yield* writeNativeWatch(
        second.config,
        {...denied.envelope, notification: {...denied.envelope.notification!, recoveryRequested: true}},
        denied.revision,
      );
      const attempt = yield* (yield* second.fresh()).drain().pipe(Effect.result);
      expect(attempt._tag).toBe('Failure');
      expect(calls).toBe(1);
      const interrupted = yield* first.read();
      yield* writeNativeWatch(
        first.config,
        {...interrupted.envelope, notification: {...interrupted.envelope.notification!, recoveryRequested: true}},
        interrupted.revision,
      );
      yield* (yield* first.fresh()).drain().pipe(
        commandLayer(() => {
          calls++;
          return Effect.succeed(cursorReply);
        }),
      );
      expect(calls).toBe(2);
    }).pipe(provide, TestClock.withLive),
);

effectIt.effect('observes a typed async receipt-write failure and forbids further state mutations or host replay', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1);
    yield* useCursor(f);
    const fs = yield* FileSystem.FileSystem;
    const attemptedWrite = yield* Deferred.make<void>();
    let armed = false;
    let writesAfterFailure = 0;
    let calls = 0;
    const failing = FileSystem.FileSystem.of({
      ...fs,
      rename: (from, to) =>
        Effect.gen(function* () {
          if (!EffectString.endsWith('/watch-1.json')(EffectString.replaceAll('\\', '/')(to)))
            return yield* fs.rename(from, to);
          if (armed) {
            writesAfterFailure++;
            return yield* fs.rename(from, to);
          }
          const bytes = yield* fs.readFileString(from);
          if (EffectString.includes('"status":"completed"')(bytes)) {
            armed = true;
            yield* Deferred.succeed(attemptedWrite, undefined);
            return yield* PlatformError.systemError({
              _tag: 'Unknown',
              module: 'FileSystem',
              method: 'rename',
              description: 'injected receipt failure',
            });
          }
          yield* fs.rename(from, to);
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* f.dispatch().pipe(
          commandLayer(() => {
            calls++;
            return Effect.succeed(cursorReply);
          }),
          Effect.provideService(FileSystem.FileSystem, failing),
        );
        yield* Deferred.await(attemptedWrite);
        const deadline = (yield* Clock.currentTimeMillis) + 5000;
        let firstExit = yield* f.dispatch().pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.result);
        while (firstExit._tag === 'Success' && (yield* Clock.currentTimeMillis) < deadline) {
          yield* Effect.sleep(20);
          firstExit = yield* f.dispatch().pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.result);
        }
        expect(firstExit).toMatchObject({failure: {code: 'host-notification-persistence-failed'}});
        const before = yield* f.read();
        for (let index = 0; index < 3; index++) {
          const observed = yield* f
            .dispatch()
            .pipe(Effect.provideService(FileSystem.FileSystem, failing), Effect.result);
          expect(observed).toMatchObject({failure: {code: 'host-notification-persistence-failed'}});
        }
        expect((yield* f.read()).revision).toBe(before.revision);
        expect(before.envelope.notification?.outbox?.status).toBe('sending');
        expect(writesAfterFailure).toBe(0);
        expect(calls).toBe(1);
      }),
    );
  }).pipe(provide, TestClock.withLive),
);

effectIt.effect(
  'interrupted Cursor binding cannot forget its claim; ACK and exact recovery permit a new dedicated session',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(1);
      yield* useCursor(f);
      const initial = yield* f.read();
      yield* writeNativeWatch(
        f.config,
        {
          ...initial.envelope,
          state: {...initial.envelope.state, prState: 'merged'},
          collector: {...initial.envelope.collector!, status: 'terminal', pid: 0},
        },
        initial.revision,
      );
      const started = yield* Deferred.make<void>();
      let calls = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* f.dispatch().pipe(
            commandLayer(() => {
              calls++;
              return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
            }),
          );
          yield* Deferred.await(started);
        }),
      );
      const interrupted = yield* f.read();
      const system = yield* SystemInfo;
      const request = {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: 'consumer',
        watchId: 'watch-1',
        consumerId: 'consumer',
        wakeupId: 'wakeup',
      };
      const call = (extra: Record<string, unknown> = {}) =>
        runNativeWatch(f.config, {...request, ...extra}).pipe(
          Effect.provideService(SystemInfo, {...system, homeDirectory: f.userHome}),
        );
      const dedicated = {...cursorTarget, sessionId: receipt};
      expect(
        yield* call({wakeup: dedicated, wakeupId: 'new-wakeup', recoverWakeup: true}).pipe(Effect.result),
      ).toMatchObject({failure: {code: 'wakeup-recovery-required'}});
      expect((yield* f.read()).revision).toBe(interrupted.revision);
      yield* call();
      const renewed = yield* f.read();
      const now = yield* Clock.currentTimeMillis;
      const relay = relayNativeWatch(renewed.envelope.state, 'consumer', now);
      const dispositions = Array.map(relay.delivery!.events, event => ({
        eventId: event.id,
        status: 'open' as const,
        reason: 'retained follow-up',
        evidence: 'fixture',
      }));
      const state = acknowledgeNativeWatch(
        recordNativeWatchDispositions(relay.state, 'consumer', relay.delivery!.id, dispositions, now),
        'consumer',
        relay.delivery!.id,
        now,
      );
      yield* writeNativeWatch(f.config, {...renewed.envelope, state}, renewed.revision);
      yield* call({recoverWakeup: true});
      expect((yield* f.read()).envelope.notification).toMatchObject({notifiedThrough: 1, outbox: null});
      yield* call({wakeup: dedicated, wakeupId: 'new-wakeup'});
      expect((yield* f.read()).envelope.notification?.target).toEqual(dedicated);
      expect(calls).toBe(1);
    }).pipe(provide, TestClock.withLive),
);

effectIt.effect('pre-admission host-session-owned may rebind without releasing the foreign claim', () =>
  Effect.gen(function* () {
    const f = yield* fixture(1);
    yield* useCursor(f);
    const foreignHome = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: 'native-watch-foreign-',
    });
    const foreign: NativeWatchHostClaim = {
      format: 'threadnote-native-watch-host-session',
      version: 1,
      sessionId: cursorTarget.sessionId,
      home: foreignHome,
      watchId: 'foreign-watch',
      consumerId: 'foreign-consumer',
      wakeupId: 'foreign-wakeup',
      attemptId: receipt,
      collectorToken: token,
    };
    yield* claimNativeWatchHostSession(f.userHome, foreign);
    yield* f.drain();
    expect((yield* f.read()).envelope.notification?.outbox?.error).toBe('host-session-owned');
    const fs = yield* FileSystem.FileSystem;
    const claimFile =
      f.userHome + '/.threadnote/native-watch-host-sessions-v1/cursor-' + cursorTarget.sessionId + '.json';
    const original = yield* fs.readFileString(claimFile);
    const system = yield* SystemInfo;
    const dedicated = {...cursorTarget, sessionId: receipt};
    yield* runNativeWatch(f.config, {
      protocolVersion: 1,
      executorVersion: 1,
      action: 'watch',
      command: 'consumer',
      watchId: 'watch-1',
      consumerId: 'consumer',
      wakeupId: 'new-wakeup',
      wakeup: dedicated,
    }).pipe(Effect.provideService(SystemInfo, {...system, homeDirectory: f.userHome}));
    expect((yield* f.read()).envelope.notification?.target).toEqual(dedicated);
    expect(yield* fs.readFileString(claimFile)).toBe(original);
  }).pipe(provide, TestClock.withLive),
);

effectIt.effect(
  'partial claim preparation publishes no final claim, invokes no host, and supports exact recovery',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture(1);
      yield* useCursor(f);
      const initial = yield* f.read();
      yield* writeNativeWatch(
        f.config,
        {
          ...initial.envelope,
          state: {...initial.envelope.state, prState: 'merged'},
          collector: {...initial.envelope.collector!, status: 'terminal', pid: 0},
        },
        initial.revision,
      );
      const fs = yield* FileSystem.FileSystem;
      let injected = false;
      let calls = 0;
      const partial = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (file, bytes, options) =>
          Effect.gen(function* () {
            const normalized = EffectString.replaceAll('\\', '/')(file);
            if (
              !injected &&
              EffectString.includes('/native-watch-host-sessions-v1/')(normalized) &&
              EffectString.endsWith('.tmp')(normalized)
            ) {
              injected = true;
              yield* fs.writeFileString(file, '{"format":', options);
              return yield* PlatformError.systemError({
                _tag: 'Unknown',
                module: 'FileSystem',
                method: 'writeFileString',
                description: 'injected partial preparation',
              });
            }
            yield* fs.writeFileString(file, bytes, options);
          }),
      });
      const first = yield* f.drain().pipe(
        Effect.provideService(FileSystem.FileSystem, partial),
        commandLayer(() => {
          calls++;
          return Effect.succeed(cursorReply);
        }),
        Effect.result,
      );
      expect(first).toMatchObject({failure: {code: 'host-notification-persistence-failed'}});
      expect(injected).toBe(true);
      expect(calls).toBe(0);
      const directory = f.userHome + '/.threadnote/native-watch-host-sessions-v1';
      expect(yield* fs.readDirectory(directory)).toEqual([]);
      const system = yield* SystemInfo;
      yield* runNativeWatch(f.config, {
        protocolVersion: 1,
        executorVersion: 1,
        action: 'watch',
        command: 'consumer',
        watchId: 'watch-1',
        consumerId: 'consumer',
        wakeupId: 'wakeup',
        recoverWakeup: true,
      }).pipe(
        Effect.provideService(SystemInfo, {...system, homeDirectory: f.userHome}),
        commandLayer(() => {
          calls++;
          return Effect.succeed(cursorReply);
        }),
      );
      expect(calls).toBe(1);
      expect((yield* f.read()).envelope.notification).toMatchObject({notifiedThrough: 1, outbox: null});
      expect(yield* fs.readDirectory(directory)).toEqual([]);
    }).pipe(provide, TestClock.withLive),
);

effectIt.effect(
  'atomic claim publication never overwrites a racing final claim and removes only its own preparation',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const own: NativeWatchHostClaim = {
        format: 'threadnote-native-watch-host-session',
        version: 1,
        sessionId: cursorTarget.sessionId,
        home: f.config.agentContextHome,
        watchId: 'watch-1',
        consumerId: 'consumer',
        wakeupId: 'wakeup',
        attemptId: receipt,
        collectorToken: token,
      };
      const foreign = {...own, watchId: 'foreign-watch', attemptId: 'dddddddd-dddd-4ddd-dddd-dddddddddddd'};
      const foreignBytes = JSON.stringify(foreign) + '\n';
      let finalPath = '';
      const collision = FileSystem.FileSystem.of({
        ...fs,
        link: (from, to) =>
          Effect.gen(function* () {
            finalPath = to;
            yield* fs.writeFileString(to, foreignBytes, {flag: 'wx', mode: 0o600});
            yield* fs.link(from, to);
          }),
      });
      expect(
        (yield* claimNativeWatchHostSession(f.userHome, own).pipe(
          Effect.provideService(FileSystem.FileSystem, collision),
          Effect.result,
        ))._tag,
      ).toBe('Failure');
      expect(yield* fs.readFileString(finalPath)).toBe(foreignBytes);
      const files = yield* fs.readDirectory(f.userHome + '/.threadnote/native-watch-host-sessions-v1');
      expect(files).toEqual(['cursor-' + cursorTarget.sessionId + '.json']);
    }).pipe(provide, TestClock.withLive),
);
