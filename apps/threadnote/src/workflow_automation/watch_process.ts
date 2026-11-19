import {Clock, Effect, Option} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {runDetachedCommandEffect} from '@threadnote/platform/command';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  readNativeWatch,
  readNativeWatchCollectorLockOwner,
  writeNativeWatch,
  withNativeWatchControlLock,
  type NativeWatchEnvelope,
} from './watch_store.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export function nativeWatchInvocation(
  executablePath: string,
  developmentEntrypoint: string,
  watchId: string,
  token: string,
) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(watchId) ||
    Effect2.pipe(watchId, EffectString.includes('..')) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(token)
  )
    throw WorkflowAutomationError.make({code: 'invalid-request', message: 'Invalid collector identity.'});
  const name = Effect2.pipe(
    Effect2.pipe(executablePath, EffectString.replaceAll('\\', '/'), EffectString.split('/')).at(-1),
    effectOptionalString =>
      effectOptionalString == null ? undefined : Effect2.pipe(effectOptionalString, EffectString.toLowerCase),
  );
  return {
    executable: executablePath,
    arguments: [
      ...(name === 'bun' || name === 'bun.exe' ? [developmentEntrypoint] : []),
      'workflow-automation',
      'watch-collector',
      '--watch-id',
      watchId,
      '--token',
      token,
    ],
  };
}
const processAlive = Effect.fn('nativeWatch.processAlive')(function* (pid: number, startIdentity?: string) {
  if (pid <= 0) return false;
  const system = yield* SystemInfo;
  if (!system.isProcessRunning(pid)) return false;
  const actual = yield* system.canonicalProcessStartIdentity?.(pid) ?? system.processStartIdentity(pid);
  return !startIdentity || actual === undefined || actual === startIdentity;
});
export const nativeWatchCollectorAlive = (collector: NativeWatchEnvelope['collector']) =>
  collector ? processAlive(collector.pid, collector.startIdentity) : Effect.succeed(false);
/** A live collector lock owner is still running a collector or a terminal notification recovery. */
export const nativeWatchCollectorLockHeld = Effect.fn('nativeWatch.collectorLockHeld')(function* (
  config: RuntimeConfig,
  id: string,
) {
  const owner = yield* readNativeWatchCollectorLockOwner(config, id);
  return Option.isSome(owner) && (yield* processAlive(owner.value.processId, owner.value.processStartIdentity));
});
export const launchNativeWatchProcess = Effect.fn('nativeWatch.launch')(function* (
  config: RuntimeConfig,
  id: string,
  token: string,
) {
  const system = yield* SystemInfo;
  const invocation = nativeWatchInvocation(system.executablePath, system.developmentEntrypoint, id, token);
  const attempt = Effect.gen(function* () {
    const started = yield* runDetachedCommandEffect(invocation.executable, invocation.arguments, {
      env: {...system.environment(), THREADNOTE_HOME: config.agentContextHome},
    });
    if (!started) return false;
    const deadline = (yield* Clock.currentTimeMillis) + 5000;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const current = yield* readNativeWatch(config, id);
      const collector = current?.envelope.collector;
      if (
        current &&
        collector?.token === token &&
        collector.pid > 0 &&
        collector.status === 'terminal' &&
        current.envelope.state.prState !== 'open'
      )
        return collector.pid;
      if (
        collector?.token === token &&
        collector.status === 'running' &&
        collector.pid > 0 &&
        !current!.envelope.stopRequested &&
        system.isProcessRunning(collector.pid)
      ) {
        const actual = yield* system.canonicalProcessStartIdentity?.(collector.pid) ??
          system.processStartIdentity(collector.pid);
        if (actual === undefined || actual === collector.startIdentity) return collector.pid;
      }
      yield* Effect.sleep(200);
    }
    return false;
  });
  const pid = yield* attempt.pipe(Effect.orElseSucceed(() => false));
  if (pid !== false) return {pid, token};
  yield* withNativeWatchControlLock(
    config,
    id,
    Effect.gen(function* () {
      const current = yield* readNativeWatch(config, id);
      if (current?.envelope.collector?.token === token && !current.envelope.stopRequested) {
        const collector = current.envelope.collector;
        yield* writeNativeWatch(
          config,
          {
            ...current.envelope,
            stopRequested: true,
            // Preserve terminal reasons and any explicit stop that won this lock.
            ...(current.envelope.state.prState === 'open' && collector.status === 'starting'
              ? {collector: {...collector, status: 'blocked', reason: 'collector-startup-failed'}}
              : {}),
          },
          current.revision,
        );
      }
    }),
  );
  return yield* WorkflowAutomationError.make({
    code: 'collector-startup-failed',
    message: 'Collector did not confirm a running process or completed terminal sweep within its startup deadline.',
  });
});
