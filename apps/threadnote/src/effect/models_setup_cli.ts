import {Effect} from 'effect';
import {Command} from 'effect/cli';
import {runModelSetupCommand, modelSetupPublicError} from '../models/setup.js';
import type {CliRuntimeRunner} from './cli.js';
import {boolean, optionalChoice} from './cli/flags.js';

export function makeModelsSetupCommand(withRuntime: CliRuntimeRunner) {
  return Command.make(
    'setup',
    {
      status: boolean('status', 'Read background model setup status without starting work'),
      json: boolean('json', 'Emit bounded versioned model setup status'),
      dryRun: boolean('dry-run', 'Show setup status without changing files or starting work'),
      auto: optionalChoice('auto', ['on', 'off'], 'Persist automatic model setup on or off'),
      retry: boolean('retry', 'Retry model setup while automatic setup is enabled'),
    },
    options =>
      withRuntime(config => runModelSetupCommand(config, options)).pipe(Effect.mapError(modelSetupPublicError)),
  ).pipe(Command.withDescription('Prepare the pinned generation model in the background; loading remains on demand'));
}
