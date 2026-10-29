import {Array as EffectArray} from 'effect';
import {Effect} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {SystemInfo} from '@threadnote/platform/system';
import {trimTrailingCharacters} from '@threadnote/platform/string-boundaries';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

const NOTIFICATION_TIMEOUT_MILLISECONDS = 5_000;
const NOTIFICATION_OUTPUT_LIMIT_BYTES = 4 * 1_024;

export interface SystemNotification {
  readonly body: string;
  readonly title: string;
}

export type SystemNotificationDelivery = 'failed' | 'sent' | 'unavailable';

export interface SystemNotificationInvocation {
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly executable: string;
}

/**
 * Builds an argv-safe, dependency-free desktop notification command for the
 * current platform. User-facing text is passed as argv or environment data and
 * is never interpolated into AppleScript or PowerShell source.
 */
export function systemNotificationInvocation(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  notification: SystemNotification,
): SystemNotificationInvocation | undefined {
  const title = boundedNotificationText(notification.title, 120);
  const body = boundedNotificationText(notification.body, 500);
  if (!title || !body) return undefined;
  switch (platform) {
    case 'darwin':
      return {
        args: [
          '-e',
          'on run argv\n  display notification (item 2 of argv) with title (item 1 of argv)\nend run',
          '--',
          title,
          body,
        ],
        executable: '/usr/bin/osascript',
      };
    case 'linux':
      return {
        args: ['--app-name=Threadnote', '--expire-time=10000', title, body],
        executable: 'notify-send',
      };
    case 'win32': {
      const systemRoot = trimTrailingCharacters(
        environment.SystemRoot ?? environment.SYSTEMROOT ?? 'C:\\Windows',
        '/\\',
      );
      return {
        args: ['-NoProfile', '-NonInteractive', '-Command', windowsToastScript],
        env: {
          ...environment,
          THREADNOTE_NOTIFICATION_BODY: body,
          THREADNOTE_NOTIFICATION_TITLE: title,
        },
        executable: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      };
    }
    default:
      return undefined;
  }
}

/** Best-effort delivery. Notification availability never changes update success. */
export const sendSystemNotification = Effect.fn('systemNotification.send')(function* (
  notification: SystemNotification,
) {
  const system = yield* SystemInfo;
  const invocation = systemNotificationInvocation(system.platform, system.environment(), notification);
  if (!invocation) return 'unavailable' as const;
  const result = yield* runCommandEffect(invocation.executable, invocation.args, {
    allowFailure: true,
    env: invocation.env,
    maxOutputBytes: NOTIFICATION_OUTPUT_LIMIT_BYTES,
    timeoutMs: NOTIFICATION_TIMEOUT_MILLISECONDS,
  }).pipe(Effect.orElseSucceed(() => ({exitCode: 127, stderr: '', stdout: ''})));
  if (result.exitCode === 0) return 'sent' as const;
  return result.exitCode === 127 ? ('unavailable' as const) : ('failed' as const);
});

function boundedNotificationText(value: string, maximumLength: number): string {
  return Effect2.pipe(
    value,
    EffectString.replaceAll('\0', ''),
    EffectString.trim,
    EffectString.slice(0, maximumLength),
  );
}

const windowsToastScript = EffectArray.join(
  [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$title=[Security.SecurityElement]::Escape($env:THREADNOTE_NOTIFICATION_TITLE)',
    '$body=[Security.SecurityElement]::Escape($env:THREADNOTE_NOTIFICATION_BODY)',
    '$xml=New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$xml.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>$title</text><text>$body</text></binding></visual></toast>")',
    '$toast=New-Object Windows.UI.Notifications.ToastNotification $xml',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Threadnote").Show($toast)',
  ],
  '; ',
);
