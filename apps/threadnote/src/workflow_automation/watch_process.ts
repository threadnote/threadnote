import {Clock, Effect} from 'effect';
import {SystemInfo} from '@threadnote/platform/system';
import {runDetachedCommandEffect} from '@threadnote/platform/command';
import {WorkflowAutomationError} from '@threadnote/workflow-automations/contracts';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {
  readNativeWatch,
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
export const nativeWatchCollectorAlive = Effect.fn('nativeWatch.collectorAlive')(function* (
  collector: NativeWatchEnvelope['collector'],
) {
  if (!collector || collector.pid <= 0) return false;
  const system = yield* SystemInfo;
  if (!system.isProcessRunning(collector.pid)) return false;
  const actual = yield* system.canonicalProcessStartIdentity?.(collector.pid) ??
    system.processStartIdentity(collector.pid);
  return !collector.startIdentity || actual === undefined || actual === collector.startIdentity;
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
      if (current?.envelope.collector?.token === token)
        yield* writeNativeWatch(config, {...current.envelope, stopRequested: true}, current.revision);
    }),
  );
  return yield* WorkflowAutomationError.make({
    code: 'collector-startup-failed',
    message: 'Collector did not confirm a running process or completed terminal sweep within its startup deadline.',
  });
});
