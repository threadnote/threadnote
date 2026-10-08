import {Console, Effect} from 'effect';
import {runCommandEffect} from '@threadnote/platform/command';
import {maybeRunEffect} from '../../effect/command-presentation.js';
import {SystemInfo} from '@threadnote/platform/system';
import {resolveProjectedMemoryPath} from './projection.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {findExecutable, toPosixPath} from '../../utils.js';

export interface ObsidianOpenOptions {
  readonly dryRun?: boolean;
  readonly projection?: string;
}

export const runObsidianOpen = Effect.fn('obsidian.open')(function* (
  config: RuntimeConfig,
  uri: string,
  options: ObsidianOpenOptions,
) {
  const resolved = yield* resolveProjectedMemoryPath(config, uri, options.projection);
  const vaultRelativePath = toPosixPath(`${resolved.projection.folder}/${resolved.relativePath}`);
  const obsidian = yield* findExecutable(['obsidian']);
  if (obsidian) {
    if (options.dryRun === true) {
      yield* maybeRunEffect(true, obsidian, ['open', `path=${vaultRelativePath}`], {
        cwd: resolved.projection.vault,
      });
      return;
    }
    const result = yield* runCommandEffect(obsidian, ['open', `path=${vaultRelativePath}`], {
      allowFailure: true,
      cwd: resolved.projection.vault,
    });
    if (result.exitCode === 0) {
      yield* Console.log(`Opened ${uri} in Obsidian projection "${resolved.projection.id}".`);
      return;
    }
    yield* Console.log('WARN Obsidian CLI did not open the note; falling back to the registered Obsidian URI.');
  }
  const openUri = obsidianOpenUri(resolved.path);
  const invocation = yield* platformUriOpener(openUri);
  yield* maybeRunEffect(options.dryRun === true, invocation.executable, invocation.args, {allowFailure: false});
  if (options.dryRun !== true) {
    yield* Console.log(`Opened ${uri} through the Obsidian URI handler.`);
  }
});

export function obsidianOpenUri(absolutePath: string): string {
  return `obsidian://open?path=${encodeURIComponent(absolutePath)}`;
}

const platformUriOpener = Effect.fn('obsidian.platformUriOpener')(function* (uri: string) {
  const system = yield* SystemInfo;
  if (system.platform === 'darwin') {
    return {args: [uri], executable: 'open'};
  }
  if (system.platform === 'win32') {
    return {args: ['url.dll,FileProtocolHandler', uri], executable: 'rundll32.exe'};
  }
  const executable = (yield* findExecutable(['xdg-open'])) ?? 'xdg-open';
  return {args: [uri], executable};
});
