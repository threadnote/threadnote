import {Command} from 'effect/cli';
import type {CliRuntimeRunner} from '../effect/cli_runtime_contract.js';
import {argument, negatedBoolean} from '../effect/cli/flags.js';
import {runMemoryPreview} from './server.js';
import {decodeMemoryLaunchUri} from '@threadnote/memory/navigation-link';

/** Validate raw process arguments before shared flags or runtime configuration are read. */
export function validMemoryPreviewArguments(args: readonly string[]): boolean {
  if (args[0] !== 'memory-preview' || (args.length !== 2 && !(args.length === 3 && args[2] === '--no-open')))
    return false;
  try {
    decodeMemoryLaunchUri(args[1]);
    return true;
  } catch {
    return false;
  }
}

export function makeMemoryPreviewCommand(withRuntime: CliRuntimeRunner) {
  return Command.make(
    'memory-preview',
    {
      launchUri: argument('launch-uri', 'Validated threadnote://open/v1 memory launch URI'),
      open: negatedBoolean('open', 'Internal test mode: start preview without opening a browser'),
    },
    ({launchUri, open}) => withRuntime(config => runMemoryPreview(config, launchUri, {open})),
  ).pipe(Command.withDescription('Open one private memory in a read-only local preview'));
}
