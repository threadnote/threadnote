import {Effect} from 'effect';
import {Argument, Command} from 'effect/cli';
import {getAgentAdapter} from '../agent_integration/adapters.js';
import {runSetup, SetupOperationError} from '../setup/index.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {boolean, optionalChoice, optionalString} from './cli/flags.js';

export const setupCommandMetadata = {productionLog: {mode: 'requires-apply'}} as const;

export function makeSetupCommand(
  withRuntime: <E, R>(body: (config: RuntimeConfig) => Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'setup',
    {
      apply: boolean('apply', 'Execute the setup plan; otherwise preview it'),
      cwd: optionalString('cwd', 'Repository path; defaults to the current working directory'),
      scope: optionalChoice('scope', ['user', 'project', 'local'], 'Managed JSON surface installation scope'),
      surface: Argument.String('surface').pipe(Argument.withDescription('Agent surface from `threadnote agents list`')),
      undo: boolean('undo', 'Preview receipt-owned rollback; combine with --apply to execute it'),
    },
    ({surface, ...options}) =>
      withRuntime(
        Effect.fn(function* (config: RuntimeConfig) {
          const adapter = getAgentAdapter(surface);
          if (!adapter)
            return yield* SetupOperationError.make({
              message: `Unknown surface ${surface}; run threadnote agents list.`,
            });
          yield* runSetup(config, adapter, options);
        }),
      ),
  ).pipe(Command.withDescription('Preview or apply one resumable local Threadnote setup plan'));
}
