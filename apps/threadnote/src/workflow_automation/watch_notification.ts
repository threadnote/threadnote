import * as Clock from 'effect/Clock';
import * as Crypto from 'effect/Crypto';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as EffectString from 'effect/String';
import {SystemInfo} from '@threadnote/platform/system';
import {attachNativeWatchConsumer} from '@threadnote/workflow-automations/watch';
import {runCommandEffect} from '@threadnote/platform/command';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {readNativeWatch, writeNativeWatch, withNativeWatchControlLock} from './watch_store.js';
import {
  nativeWatchNotice,
  stageNativeWatchNotification,
  type NativeWatchNotification,
} from './watch_notification_state.js';
import {
  claimNativeWatchHostSession,
  releaseNativeWatchHostSession,
  type NativeWatchHostClaim,
} from './watch_host_session.js';
import {stableJson} from '../workflow_memory/protocol.js';

/** Read-only capability admission for an explicitly selected executable; never queue a probe message. */
export const preflightNativeWatchCodexQueue = Effect.fn('nativeWatch.preflightCodexQueue')(function* (
  executable: string,
) {
  const incompatible = () =>
    WorkflowAutomationError.make({
      code: 'host-queue-incompatible',
      message:
        'The selected Codex executable could not verify queue --help with --thread and --message support: ' +
        executable +
        '. Select a compatible absolute Codex executable explicitly and retry this binding; no watch target was changed.',
    });
  const result = yield* runCommandEffect(executable, ['queue', '--help'], {
    allowFailure: true,
    timeoutMs: 5_000,
    maxOutputBytes: 16_384,
  }).pipe(Effect.mapError(incompatible));
  const help = result.stdout + '\n' + result.stderr;
  if (
    result.exitCode !== 0 ||
    !/^Usage:\s+codex(?:\.exe)?\s+queue(?:\s|$)/imu.test(help) ||
    !/^\s+(?:-\w,\s+)?--thread\s+<[^>\r\n]+>/mu.test(help) ||
    !/^\s+(?:-\w,\s+)?--message\s+<[^>\r\n]+>/mu.test(help)
  )
    return yield* incompatible();
});

function cursorCompletionReceipt(stdout: string, sessionId: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed &&
      typeof parsed === 'object' &&
      'type' in parsed &&
      parsed.type === 'result' &&
      'subtype' in parsed &&
      parsed.subtype === 'success' &&
      'is_error' in parsed &&
      parsed.is_error === false &&
      'session_id' in parsed &&
      typeof parsed.session_id === 'string' &&
      EffectString.toLowerCase(parsed.session_id) === EffectString.toLowerCase(sessionId)
      ? sessionId
      : undefined;
  } catch {
    return undefined;
  }
}
const persistenceFailure = () =>
  WorkflowAutomationError.make({
    code: 'host-notification-persistence-failed',
    message: 'The owned host worker failed to persist its outcome. No dependent mutation or host replay was applied.',
  });
const hostClaim = (config: RuntimeConfig, notification: NativeWatchNotification): NativeWatchHostClaim => {
  const target = notification.target;
  if (target.host !== 'cursor-cli' || !notification.outbox?.attemptId || !notification.outbox.collectorToken)
    throw new Error('A Cursor host claim requires a retained attempt.');
  return {
    format: 'threadnote-native-watch-host-session',
    version: 1,
    sessionId: EffectString.toLowerCase(target.sessionId),
    home: config.agentContextHome,
    watchId: EffectString.split(notification.outbox.key, ':')[0],
    consumerId: notification.consumerId,
    wakeupId: notification.wakeupId,
    attemptId: notification.outbox.attemptId,
    collectorToken: notification.outbox.collectorToken,
  };
};

export const maintainNativeWatchSubscription = Effect.fn('nativeWatch.maintainSubscription')(function* (
  config: RuntimeConfig,
  watchId: string,
  collectorToken: string,
) {
  yield* withNativeWatchControlLock(
    config,
    watchId,
    Effect.gen(function* () {
      const stored = yield* readNativeWatch(config, watchId);
      const subscription = stored?.envelope.notification;
      const consumer = stored?.envelope.state.consumer;
      const now = yield* Clock.currentTimeMillis;
      if (
        !stored ||
        stored.envelope.collector?.token !== collectorToken ||
        !subscription ||
        !consumer ||
        now < consumer.lastSeenAt + consumer.leaseMilliseconds / 2
      )
        return;
      const state = attachNativeWatchConsumer(
        stored.envelope.state,
        {id: subscription.consumerId, wakeupId: subscription.wakeupId},
        now,
        {leaseMilliseconds: consumer.leaseMilliseconds},
      );
      yield* writeNativeWatch(config, {...stored.envelope, state}, stored.revision);
    }),
  );
});

/** The controller owns actual fibers; a durable nonce alone never proves a host child is running. */
export const makeNativeWatchNotifier = Effect.fn('nativeWatch.notifier')(function* (
  config: RuntimeConfig,
  watchId: string,
  collectorToken: string,
) {
  const userHome = (yield* SystemInfo).homeDirectory;
  let failed = false;
  let owned: undefined | {outcome: Deferred.Deferred<Exit.Exit<void, unknown>>};
  const tick = Effect.fn('nativeWatch.notify')(function* () {
    if (failed) return yield* persistenceFailure();
    if (owned) {
      const polled = yield* Deferred.poll(owned.outcome);
      if (Option.isNone(polled)) return;
      const exit = yield* polled.value;
      owned = undefined;
      if (Exit.isFailure(exit)) {
        failed = true;
        return yield* persistenceFailure();
      }
    }
    const claimed = yield* withNativeWatchControlLock(
      config,
      watchId,
      Effect.gen(function* () {
        let stored = yield* readNativeWatch(config, watchId);
        if (!stored || stored.envelope.collector?.token !== collectorToken || !stored.envelope.notification) return;
        const now = yield* Clock.currentTimeMillis;
        let notification = stored.envelope.notification;
        let pending = notification.outbox;
        if (pending?.status === 'queued' || pending?.status === 'completed') {
          if (notification.target.host === 'cursor-cli')
            yield* releaseNativeWatchHostSession(userHome, hostClaim(config, notification), true);
          notification = {
            ...notification,
            notifiedThrough: Math.max(pending.last, stored.envelope.state.acknowledged),
            recoveryRequested: false,
            outbox: null,
            lastReceipt: {
              key: pending.key,
              receipt: pending.receipt!,
              attemptId: pending.attemptId!,
              kind: pending.status === 'queued' ? 'queued-message' : 'cli-session-completed',
              at: now,
            },
          };
          yield* writeNativeWatch(config, {...stored.envelope, notification}, stored.revision);
          return;
        }
        if (pending?.status === 'sending') {
          notification = {...notification, outbox: {...pending, status: 'failed', error: 'host-delivery-ambiguous'}};
          stored = yield* writeNativeWatch(config, {...stored.envelope, notification}, stored.revision);
          pending = notification.outbox;
        }
        if (notification.recoveryRequested) {
          // An explicit recovery confirms the previous host attempt is safe to retry; it cannot steal another watch's claim.
          if (pending?.attemptId && notification.target.host === 'cursor-cli')
            yield* releaseNativeWatchHostSession(userHome, hostClaim(config, notification));
          notification = {
            ...notification,
            recoveryRequested: false,
            outbox: pending ? {...pending, attempts: 0, status: 'pending', nextAttemptAt: now} : null,
          };
          stored = yield* writeNativeWatch(config, {...stored.envelope, notification}, stored.revision);
        }
        notification = stageNativeWatchNotification(notification, stored.envelope.state, now);
        pending = notification.outbox;
        if (!pending) {
          if (stableJson(notification) !== stableJson(stored.envelope.notification))
            yield* writeNativeWatch(config, {...stored.envelope, notification}, stored.revision);
          return;
        }
        if (pending.status === 'failed') return;
        const attemptId = yield* (yield* Crypto.Crypto).randomUUIDv4();
        notification = {
          ...notification,
          outbox: {...pending, attempts: 1, attemptId, collectorToken, status: 'sending', nextAttemptAt: now},
        };
        const saved = yield* writeNativeWatch(config, {...stored.envelope, notification}, stored.revision);
        return {notification: saved.envelope.notification!, attemptId};
      }),
    );
    if (!claimed) return;
    const {target, outbox} = claimed.notification;
    const finish = (receipt: string | undefined, error: 'host-delivery-ambiguous' | 'host-session-owned') =>
      withNativeWatchControlLock(
        config,
        watchId,
        Effect.gen(function* () {
          const stored = yield* readNativeWatch(config, watchId);
          const current = stored?.envelope.notification;
          if (
            !stored ||
            stored.envelope.collector?.token !== collectorToken ||
            !current ||
            current.consumerId !== claimed.notification.consumerId ||
            current.wakeupId !== claimed.notification.wakeupId ||
            stableJson(current.target) !== stableJson(target) ||
            current.outbox?.attemptId !== claimed.attemptId
          )
            return;
          const {error: _previousError, ...pending} = current.outbox;
          const notification = {
            ...current,
            outbox: receipt
              ? {...pending, status: target.host === 'codex' ? ('queued' as const) : ('completed' as const), receipt}
              : {...pending, status: 'failed' as const, error},
          };
          yield* writeNativeWatch(config, {...stored.envelope, notification}, stored.revision);
        }),
      );
    const delivery = Effect.gen(function* () {
      let claim: NativeWatchHostClaim | undefined;
      if (target.host === 'cursor-cli') {
        claim = hostClaim(config, claimed.notification);
        const admitted = yield* claimNativeWatchHostSession(userHome, claim).pipe(Effect.result);
        if (admitted._tag === 'Failure') {
          if (isHostSessionOwned(admitted.failure)) {
            yield* finish(undefined, 'host-session-owned');
            return;
          }
          return yield* Effect.fail(admitted.failure);
        }
      }
      const notice = nativeWatchNotice(
        {
          home: config.agentContextHome,
          watchId,
          consumerId: claimed.notification.consumerId,
          wakeupId: claimed.notification.wakeupId,
        },
        outbox!,
      );
      const args =
        target.host === 'codex'
          ? ['queue', '--thread', target.threadId, '--message', notice]
          : [
              '--print',
              '--resume',
              target.sessionId,
              '--workspace',
              target.workspace,
              '--output-format',
              'json',
              notice,
            ];
      const result = yield* runCommandEffect(target.executable, args, {
        timeoutMs: target.host === 'codex' ? 10_000 : 0,
        maxOutputBytes: target.host === 'codex' ? 4096 : 65_536,
      }).pipe(Effect.result);
      let receipt: string | undefined;
      if (result._tag === 'Success' && result.success.exitCode === 0) {
        if (target.host === 'codex')
          receipt = new RegExp(
            '^Queued message ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}) for thread ' +
              target.threadId +
              '\\.$',
            'iu',
          ).exec(EffectString.trim(result.success.stdout))?.[1];
        else receipt = cursorCompletionReceipt(result.success.stdout, target.sessionId);
      }
      // A timeout, nonzero exit, or malformed receipt can follow host acceptance. Never retry automatically.
      yield* finish(receipt, 'host-delivery-ambiguous');
      if (claim) yield* releaseNativeWatchHostSession(userHome, claim);
    });
    if (target.host === 'cursor-cli') {
      const outcome = yield* Deferred.make<Exit.Exit<void, unknown>>();
      yield* delivery.pipe(
        Effect.onInterrupt(() => finish(undefined, 'host-delivery-ambiguous')),
        Effect.onExit(exit => Deferred.succeed(outcome, exit)),
        Effect.forkScoped,
      );
      owned = {outcome};
    } else yield* delivery.pipe(Effect.mapError(() => persistenceFailure()));
  });
  const drain = Effect.fn('nativeWatch.drainNotifications')(function* () {
    for (;;) {
      yield* maintainNativeWatchSubscription(config, watchId, collectorToken);
      yield* tick();
      const stored = yield* readNativeWatch(config, watchId);
      const notification = stored?.envelope.notification;
      if (!stored || stored.envelope.collector?.token !== collectorToken || !notification) return;
      if ((notification.outbox?.status === 'failed' && !owned) || (stored.envelope.stopRequested && owned)) return;
      if (!notification.outbox && notification.notifiedThrough === stored.envelope.state.nextSequence - 1) return;
      if (owned) yield* Effect.sleep(100);
    }
  });
  return {
    tick: () =>
      tick().pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            failed = true;
          }),
        ),
        Effect.mapError(() => persistenceFailure()),
      ),
    drain: () =>
      drain().pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            failed = true;
          }),
        ),
        Effect.mapError(() => persistenceFailure()),
      ),
  };
});
function isHostSessionOwned(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'code' in value && value.code === 'host-session-owned';
}
