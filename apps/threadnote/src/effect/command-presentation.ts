import {Console, Effect} from 'effect';
import {command as commandText, info, warning} from '../cli_ui.js';
import {formatShellCommand, runCommandEffect, type CommandOptions} from '@threadnote/platform/command';
import * as EffectString from 'effect/String';
import * as Effect2 from 'effect';

export const maybeRunEffect = Effect.fn('maybeRunEffect')(function* (
  dryRun: boolean,
  executable: string,
  args: readonly string[],
  options: Pick<CommandOptions, 'allowFailure' | 'cwd' | 'timeoutMs'> = {},
) {
  const cwdSuffix = options.cwd ? ` (cwd: ${options.cwd})` : '';
  const label = dryRun ? warning('Would run') : info('Running');
  yield* Console.log(`${label}: ${commandText(formatShellCommand(executable, args))}${cwdSuffix}`);
  if (dryRun) return undefined;
  const result = yield* runCommandEffect(executable, args, options);
  if (Effect2.pipe(result.stdout, EffectString.trim))
    yield* Console.log(Effect2.pipe(result.stdout, EffectString.trim));
  if (Effect2.pipe(result.stderr, EffectString.trim))
    yield* Console.error(Effect2.pipe(result.stderr, EffectString.trim));
  return result;
});
