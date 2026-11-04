import {Command} from 'effect/cli';
import type {CliRuntimeRunner} from '../effect/cli_runtime_contract.js';
import {argument, negatedBoolean} from '../effect/cli/flags.js';
import {runMemoryPreview} from './server.js';

export function makeMemoryPreviewCommand(withRuntime: CliRuntimeRunner) {
  return Command.make(
    'memory-preview',
    {
      launchUri: argument('launch-uri', 'Validated threadnote://open/v1 memory launch URI'),
      open: negatedBoolean('open', 'Start the private preview without opening a browser'),
    },
    ({launchUri, open}) => withRuntime(config => runMemoryPreview(config, launchUri, {open})),
  ).pipe(Command.withDescription('Open one private memory in a read-only local preview'));
}
