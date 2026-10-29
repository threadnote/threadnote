import {TestSystemInfoLayer} from '../helpers/system-layer.js';
import {it as effectIt} from '@effect/vitest';
import {Effect} from 'effect';
import {describe, expect, it} from 'vitest';
import {CommandExecutor, CommandSpawnFailed} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {sendSystemNotification, systemNotificationInvocation} from '@threadnote/threadnote/system_notification';
import {provideTestLayer} from '../helpers/effect-layer.js';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';
import {Array as EffectArray, Option as EffectOption} from 'effect';

describe('system notifications', () => {
  it('passes macOS notification text as argv instead of AppleScript source', () => {
    const title = 'Threadnote "updated"';
    const body = 'New version\\nend run\ndo shell script "unsafe"';
    const invocation = systemNotificationInvocation('darwin', {}, {body, title});

    expect(invocation).toEqual({
      args: [
        '-e',
        'on run argv\n  display notification (item 2 of argv) with title (item 1 of argv)\nend run',
        '--',
        title,
        body,
      ],
      executable: '/usr/bin/osascript',
    });
    expect(invocation?.args[1]).not.toContain(title);
    expect(invocation?.args[1]).not.toContain(body);
  });

  it('passes Windows notification text through environment data and uses an absolute system executable', () => {
    const title = 'Threadnote $env:PATH';
    const body = '</text><script>unsafe</script>';
    const invocation = systemNotificationInvocation('win32', {SystemRoot: 'D:\\Windows\\'}, {body, title});

    expect(invocation?.executable).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(invocation?.env?.THREADNOTE_NOTIFICATION_TITLE).toBe(title);
    expect(invocation?.env?.THREADNOTE_NOTIFICATION_BODY).toBe(body);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(invocation?.args), __effectArrayJoinReceiver =>
          EffectArray.join(__effectArrayJoinReceiver, '\n'),
        ),
      ),
    ).not.toContain(title);
    expect(
      EffectOption.getOrUndefined(
        EffectOption.map(EffectOption.fromNullishOr(invocation?.args), __effectArrayJoinReceiver =>
          EffectArray.join(__effectArrayJoinReceiver, '\n'),
        ),
      ),
    ).not.toContain(body);
  });

  it('uses notify-send on Linux and reports unsupported platforms', () => {
    expect(systemNotificationInvocation('linux', {}, {body: 'Installed safely', title: 'Threadnote updated'})).toEqual({
      args: ['--app-name=Threadnote', '--expire-time=10000', 'Threadnote updated', 'Installed safely'],
      executable: 'notify-send',
    });
    expect(systemNotificationInvocation('aix', {}, {body: 'Installed safely', title: 'Threadnote updated'})).toBe(
      undefined,
    );
  });

  it('rejects empty notification text and bounds payload size', () => {
    expect(systemNotificationInvocation('darwin', {}, {body: '  ', title: 'Threadnote'})).toBe(undefined);
    const invocation = systemNotificationInvocation(
      'linux',
      {},
      {body: Effect2.pipe('b', EffectString.repeat(700)), title: Effect2.pipe('t', EffectString.repeat(200))},
    );
    expect(invocation?.args.at(-2)).toHaveLength(120);
    expect(invocation?.args.at(-1)).toHaveLength(500);
  });

  effectIt.effect('classifies delivery outcomes without making notification failure fatal', () =>
    Effect.gen(function* () {
      const baseSystem = yield* SystemInfo;
      const linuxSystem = SystemInfo.of({...baseSystem, environment: () => ({}), platform: 'linux'});
      let recordedOptions: unknown;
      const executor = (exitCode: number) =>
        CommandExecutor.of({
          execute: (_executable, _args, options) => {
            recordedOptions = options;
            return Effect.succeed({exitCode, stderr: '', stdout: ''});
          },
          executeStreaming: () => Effect.die('not used'),
        });
      const notification = {body: 'Installed safely', title: 'Threadnote updated'};
      const sent = yield* sendSystemNotification(notification).pipe(
        Effect.provideService(SystemInfo, linuxSystem),
        Effect.provideService(CommandExecutor, executor(0)),
      );
      const failed = yield* sendSystemNotification(notification).pipe(
        Effect.provideService(SystemInfo, linuxSystem),
        Effect.provideService(CommandExecutor, executor(2)),
      );
      const missing = yield* sendSystemNotification(notification).pipe(
        Effect.provideService(SystemInfo, linuxSystem),
        Effect.provideService(CommandExecutor, executor(127)),
      );
      const spawnFailure = CommandSpawnFailed.make({
        args: [],
        cause: new Error('missing notifier'),
        executable: 'notify-send',
        message: 'missing notifier',
      });
      const unavailable = yield* sendSystemNotification(notification).pipe(
        Effect.provideService(SystemInfo, linuxSystem),
        Effect.provideService(
          CommandExecutor,
          CommandExecutor.of({
            execute: () => Effect.fail(spawnFailure),
            executeStreaming: () => Effect.die('not used'),
          }),
        ),
      );
      const unsupported = yield* sendSystemNotification(notification).pipe(
        Effect.provideService(SystemInfo, SystemInfo.of({...baseSystem, platform: 'aix'})),
        Effect.provideService(CommandExecutor, executor(0)),
      );

      expect(sent).toBe('sent');
      expect(failed).toBe('failed');
      expect(missing).toBe('unavailable');
      expect(unavailable).toBe('unavailable');
      expect(unsupported).toBe('unavailable');
      expect(recordedOptions).toMatchObject({allowFailure: true, maxOutputBytes: 4_096, timeoutMs: 5_000});
    }).pipe(provideTestLayer(TestSystemInfoLayer)),
  );
});
