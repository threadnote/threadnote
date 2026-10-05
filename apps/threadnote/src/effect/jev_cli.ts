import {Command} from 'effect/cli';
import {runJevStatusCommand} from './ai/jev.js';
import {boolean} from './cli/flags.js';

export function makeJevCommand() {
  const status = Command.make(
    'status',
    {json: boolean('json', 'Print the safe Jev configuration diagnostic as JSON')},
    options => runJevStatusCommand(options.json),
  ).pipe(
    Command.withDescription(
      'Show the local opt-in Jev decision-provider configuration without making a network request',
    ),
  );

  return Command.make('jev').pipe(
    Command.withDescription('Inspect the optional TypeSafe Jev recall decision provider'),
    Command.withSubcommands([status]),
  );
}
