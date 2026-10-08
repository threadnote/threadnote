import {Console, Effect} from 'effect';
import {Command} from 'effect/cli';
import {applicationError} from '@threadnote/platform/errors';
import {runSlackPilotProbe} from '../integrations/slack/command.js';
import {requiredString} from './cli/flags.js';

export function makeSlackCommand() {
  const probe = Command.make(
    'probe',
    {input: requiredString('input', 'Absolute path to an owner-only pilot task JSON file')},
    ({input}) =>
      runSlackPilotProbe(input).pipe(
        Effect.mapError(error => applicationError('Slack pilot', error.code)),
        Effect.flatMap(summary => Console.log(summary.trimEnd())),
      ),
  ).pipe(Command.withDescription('Probe scoped live Slack retrieval; print structural evidence only'));
  return Command.make('slack').pipe(
    Command.withDescription('Run the internal Slack live-retrieval pilot'),
    Command.withSubcommands([probe]),
  );
}
