import {Effect} from 'effect';
import {runCommandEffect} from './command.js';

export function openUrlCommand(platform: NodeJS.Platform, url: string): {executable: string; args: readonly string[]} {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password)
    throw new Error('The preview opener accepts only a loopback HTTP URL.');
  if (platform === 'darwin') return {executable: 'open', args: [url]};
  if (platform === 'linux') return {executable: 'xdg-open', args: [url]};
  if (platform === 'win32') return {executable: 'explorer.exe', args: [url]};
  throw new Error(`Unsupported desktop platform: ${platform}`);
}

export const openLoopbackUrl = Effect.fn('openLoopbackUrl')(function* (url: string) {
  const command = openUrlCommand(process.platform, url);
  yield* runCommandEffect(command.executable, command.args, {timeoutMs: 10_000});
});
