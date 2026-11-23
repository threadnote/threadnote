import {SecureRandom} from 'effect/crypto';
import * as Clock from 'effect/Clock';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as EffectString from 'effect/String';
import * as EffectArray from 'effect/Array';
import {SystemInfo} from '@threadnote/platform/system';
import {attachNativeWatchConsumer} from '@threadnote/workflow-automations/watch';
import {runCommandEffect} from '@threadnote/platform/command';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  readNativeWatch,
  readNativeOwnedWatchRoute,
  writeNativeWatch,
  withNativeWatchControlLock,
} from './watch_store.js';
import * as Schema from 'effect/Schema';
import {
  isNativeWatchSessionWakeup,
  ownedQueuedNativeWatchReceipt,
  nativeWatchNotice,
  nativeWatchSessionWakeupSchema,
  type NativeWatchSessionWakeupRequest,
  stageNativeWatchNotification,
  type NativeWatchNotification,
  type NativeWatchSessionWakeup,
} from './watch_notification_state.js';
import {
  claimNativeWatchHostSession,
  releaseNativeWatchHostSession,
  type NativeWatchHostClaim,
} from './watch_host_session.js';
import {stableJson} from '../workflow_memory/protocol.js';
import {THREADNOTE_MCP_NAME} from '../constants.js';
import {readAgentIntegrationRegistry} from '../agent_integration/registry.js';

/** The one tool a woken turn needs to inspect, relay, dispose and acknowledge the notice it received. */
const nativeWatchToolSuffix = '__workflow_task_watch_pr';
/** Claude Code names MCP tools after the registered server; a malformed stored name falls back to the default. */
const claudeNativeWatchToolName = Effect.fn('nativeWatch.claudeToolName')(function* (config: RuntimeConfig) {
  const registry = yield* readAgentIntegrationRegistry(config).pipe(Effect.orElseSucceed(() => undefined));
  const name = registry?.hosts.claude?.mcp.name;
  return `mcp__${name !== undefined && /^[A-Za-z0-9_-]{1,64}$/u.test(name) ? name : THREADNOTE_MCP_NAME}${nativeWatchToolSuffix}`;
});

export const nativeWatchCodexCandidatePaths = (platform: NodeJS.Platform, homeDirectory: string): readonly string[] => {
  const macBundle = 'Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  if (platform === 'darwin')
    return [
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      homeDirectory + '/' + macBundle,
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      homeDirectory + '/.local/bin/codex',
    ];
  if (platform === 'linux') return [homeDirectory + '/.local/bin/codex', '/usr/local/bin/codex', '/usr/bin/codex'];
  return [];
};

/** How a host agent finds each wakeup field; the runtime derives only what it can read safely. */
export const nativeWatchHostRegistrationHint =
  'Pass the wakeup of the host that runs this chat. Codex: host codex with its threadId. ' +
  'Claude Code: host claude-code with the sessionId that `printenv CLAUDE_CODE_SESSION_ID` prints in a shell tool; ' +
  'the runtime uses `claude` on PATH (`command -v claude`) as the executable and the verified checkout as the workspace when you omit them. ' +
  'Cursor CLI: host cursor-cli with its sessionId and the absolute `agent` executable; the workspace defaults to the verified checkout. ' +
  'Never guess a session ID.';

const pathLauncher = Effect.fn('nativeWatch.pathLauncher')(function* (name: string) {
  const system = yield* SystemInfo;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Windows cannot spawn an extensionless npm shell shim, and a .cmd shim needs a shell; only the native .exe runs.
  const candidate = system.platform === 'win32' ? name + '.exe' : name;
  for (const directory of EffectString.split(
    system.environment().PATH ?? '',
    system.platform === 'win32' ? ';' : ':',
  )) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const file = path.join(directory, candidate);
    const info = yield* Effect.option(fs.stat(file));
    if (Option.isSome(info) && info.value.type === 'File') return file;
  }
  return undefined;
});

/** Complete a session-host wakeup request: workspace defaults to the verified checkout, and Claude Code finds its launcher. */
export const resolveNativeWatchSessionWakeup = Effect.fn('nativeWatch.resolveSessionWakeup')(function* (
  input: NativeWatchSessionWakeupRequest,
  checkout: string,
) {
  const refuse = (message: string) =>
    WorkflowAutomationError.make({
      code: 'host-registration-required',
      message: `${message} ${nativeWatchHostRegistrationHint}`,
    });
  if (input.sessionId === undefined) return yield* refuse(`The ${input.host} wakeup needs its sessionId.`);
  const executable = input.executable ?? (input.host === 'claude-code' ? yield* pathLauncher('claude') : undefined);
  if (executable === undefined)
    return yield* refuse(
      input.host === 'claude-code'
        ? 'No `claude` launcher is on PATH; pass the absolute path that `command -v claude` prints.'
        : `The ${input.host} wakeup needs its absolute executable.`,
    );
  return yield* Schema.decodeEffect(nativeWatchSessionWakeupSchema)({
    host: input.host,
    executable,
    sessionId: input.sessionId,
    workspace: input.workspace ?? checkout,
    exclusiveSession: true,
  }).pipe(Effect.mapError(() => refuse(`The ${input.host} wakeup is not a valid absolute registration.`)));
});

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

export const discoverNativeWatchCodexExecutable = Effect.fn('nativeWatch.discoverCodexExecutable')(function* () {
  const system = yield* SystemInfo;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const canonicalCandidates = new Set<string>();
  for (const candidate of nativeWatchCodexCandidatePaths(system.platform, system.homeDirectory)) {
    const resolved = yield* Effect.result(fs.realPath(candidate));
    if (
      resolved._tag === 'Success' &&
      path.isAbsolute(resolved.success) &&
      /[/\\]codex(?:\.exe)?$/iu.test(resolved.success)
    )
      canonicalCandidates.add(resolved.success);
  }
  const compatible: string[] = [];
  for (const executable of canonicalCandidates) {
    const result = yield* Effect.result(preflightNativeWatchCodexQueue(executable));
    if (result._tag === 'Success') compatible.push(executable);
  }
  if (compatible.length !== 1)
    return yield* WorkflowAutomationError.make({
      code: 'host-queue-incompatible',
      message:
        compatible.length === 0
          ? 'No known installed Codex executable passed the bounded queue capability check. Supply an explicit absolute executable; no watch target was changed.'
          : 'More than one known installed Codex executable passed the bounded queue capability check. Supply an explicit absolute executable; no watch target was changed.',
    });
  return compatible[0];
});

/** Each session host resumes the registered session for one headless turn and prints one JSON result. */
const sessionResumeCommands: Record<
  NativeWatchSessionWakeup['host'],
  (
    target: NativeWatchSessionWakeup,
    notice: string,
    watchTool: string,
  ) => {readonly args: readonly string[]; readonly cwd?: string}
> = {
  'cursor-cli': (target, notice) => ({
    args: ['--print', '--resume', target.sessionId, '--workspace', target.workspace, '--output-format', 'json', notice],
  }),
  // Claude Code has no workspace flag; the resumed turn's tools run in the process directory. A headless turn cannot
  // ask for permission, so it is allowed only the watch tool that its notice requires; every other tool keeps the
  // user's settings. The variadic allow list ends at the next option, before the notice.
  'claude-code': (target, notice, watchTool) => ({
    args: ['--print', '--resume', target.sessionId, '--allowedTools', watchTool, '--output-format', 'json', notice],
    cwd: target.workspace,
  }),
};

/** A completed turn that was still denied the watch tool did not handle its notice. */
function deniedNativeWatchTool(stdout: string): boolean {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      'permission_denials' in parsed &&
      EffectArray.isArray(parsed.permission_denials) &&
      EffectArray.some(
        parsed.permission_denials,
        denial =>
          denial !== null &&
          typeof denial === 'object' &&
          'tool_name' in denial &&
          typeof denial.tool_name === 'string' &&
          EffectString.startsWith('mcp__')(denial.tool_name) &&
          EffectString.endsWith(nativeWatchToolSuffix)(denial.tool_name),
      )
    );
  } catch {
    return false;
  }
}
function sessionCompletionReceipt(stdout: string, sessionId: string): string | undefined {
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
  if (!isNativeWatchSessionWakeup(target) || !notification.outbox?.attemptId || !notification.outbox.collectorToken)
    throw new Error('A session host claim requires a retained attempt.');
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
          const {state, collector} = stored.envelope;
          const {acknowledged, nextSequence} = state;
          // Queue acceptance is not notice arrival. ACK by an already-active consumer cannot release this gate.
          // After arrival, a later event releases it so a partial ACK cannot block every later wake.
          if (
            pending.status === 'queued' &&
            (!pending.consumedThrough ||
              (acknowledged < pending.consumedThrough && nextSequence - 1 <= pending.consumedThrough))
          )
            return;
          // Keep extended coverage after terminal ACK, including while retained dispositions still need resolution.
          if (
            state.prState === 'merged' &&
            collector?.status === 'terminal' &&
            collector.reason === 'merged' &&
            state.lastAck &&
            pending.status === 'queued' &&
            !pending.error &&
            !notification.recoveryRequested &&
            pending.consumedThrough === acknowledged &&
            pending.consumedThrough > pending.last &&
            acknowledged === nextSequence - 1 &&
            state.events.length === 0 &&
            state.delivery === null &&
            ownedQueuedNativeWatchReceipt(notification, state, notification)
          )
            return;
          if (isNativeWatchSessionWakeup(notification.target))
            yield* releaseNativeWatchHostSession(userHome, hostClaim(config, notification), true);
          notification = {
            ...notification,
            // Only ACK proves handling. When this attempt ACKed part of its range, wake again for the rest; an
            // attempt without ACK progress waits for a new event, whose range then starts after ACK.
            notifiedThrough: acknowledged >= pending.first ? acknowledged : pending.last,
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
          if (pending?.attemptId && isNativeWatchSessionWakeup(notification.target))
            yield* releaseNativeWatchHostSession(userHome, hostClaim(config, notification));
          notification = {
            ...notification,
            recoveryRequested: false,
            outbox: pending
              ? {
                  ...pending,
                  attempts: 0,
                  status: 'pending',
                  nextAttemptAt: now,
                  ...(notification.target.host === 'codex' ? {consumedThrough: 0} : {}),
                }
              : null,
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
        const attemptId = yield* (yield* SecureRandom.SecureRandom).uuidV4();
        notification = {
          ...notification,
          outbox: {
            ...pending,
            attempts: 1,
            attemptId,
            collectorToken,
            status: 'sending',
            nextAttemptAt: now,
            ...(notification.target.host === 'codex' ? {consumedThrough: 0} : {}),
          },
        };
        const saved = yield* writeNativeWatch(config, {...stored.envelope, notification}, stored.revision);
        return {notification: saved.envelope.notification!, attemptId};
      }),
    );
    if (!claimed) return;
    const {target, outbox} = claimed.notification;
    const finish = (
      receipt: string | undefined,
      error: 'host-delivery-ambiguous' | 'host-session-owned' | 'host-permission-denied',
    ) =>
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
      if (isNativeWatchSessionWakeup(target)) {
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
      const semantic = yield* readNativeOwnedWatchRoute(config, watchId);
      const notice = nativeWatchNotice(
        {
          home: config.agentContextHome,
          watchId,
          consumerId: claimed.notification.consumerId,
          wakeupId: claimed.notification.wakeupId,
          ...(semantic ? {semantic} : {}),
        },
        outbox!,
      );
      const command =
        target.host === 'codex'
          ? {args: ['queue', '--thread', target.threadId, '--message', notice]}
          : sessionResumeCommands[target.host](
              target,
              notice,
              target.host === 'claude-code' ? yield* claudeNativeWatchToolName(config) : '',
            );
      const result = yield* runCommandEffect(target.executable, command.args, {
        ...(command.cwd === undefined ? {} : {cwd: command.cwd}),
        timeoutMs: target.host === 'codex' ? 10_000 : 0,
        maxOutputBytes: target.host === 'codex' ? 4096 : 65_536,
      }).pipe(Effect.result);
      let receipt: string | undefined;
      let error: 'host-delivery-ambiguous' | 'host-permission-denied' = 'host-delivery-ambiguous';
      if (result._tag === 'Success' && result.success.exitCode === 0) {
        if (target.host === 'codex')
          receipt = new RegExp(
            '^Queued message ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}) for thread ' +
              target.threadId +
              '\\.$',
            'iu',
          ).exec(EffectString.trim(result.success.stdout))?.[1];
        else {
          receipt = sessionCompletionReceipt(result.success.stdout, target.sessionId);
          if (receipt && target.host === 'claude-code' && deniedNativeWatchTool(result.success.stdout)) {
            receipt = undefined;
            error = 'host-permission-denied';
          }
        }
      }
      // A timeout, nonzero exit, or malformed receipt can follow host acceptance. Never retry automatically.
      yield* finish(receipt, error);
      if (claim) yield* releaseNativeWatchHostSession(userHome, claim);
    });
    if (isNativeWatchSessionWakeup(target)) {
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
      // The host queue owns the wait for arrival/ACK; terminal collection must also return without polling it.
      if (notification.target.host === 'codex' && notification.outbox?.status === 'queued') return;
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
