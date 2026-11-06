import {Argument, Command} from 'effect/cli';
import type {CliRuntimeRunner} from './cli_runtime_contract.js';
import {argument, boolean} from './cli/flags.js';
import {runModelClear, runModelSelect} from '../models/commands.js';

export function makeModelSelectionCommands(withRuntimeEffect: CliRuntimeRunner) {
  const modelsSelect = Command.make(
    'select',
    {
      dryRun: boolean('dry-run', 'Show the role selection without changing it'),
      modelId: argument('model-id', 'Installed model ID'),
      role: Argument.Literals('role', ['embedding', 'graph', 'recall', 'reranker', 'generation']),
    },
    ({modelId, role, ...options}) => withRuntimeEffect(config => runModelSelect(config, role, modelId, options)),
  ).pipe(Command.withDescription('Select a verified installed model for a runtime role or embedding purpose'));

  const modelsClear = Command.make('clear', {purpose: Argument.Literals('purpose', ['graph', 'recall'])}, ({purpose}) =>
    withRuntimeEffect(config => runModelClear(config, purpose)),
  );

  return [modelsSelect, modelsClear];
}
