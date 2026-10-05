import {Effect} from 'effect';
import {Command} from 'effect/cli';
import {boolean} from './cli/flags.js';

export function makeImageProjectionCommand<E, R>(
  run: (options: {readonly disable: boolean; readonly enable: boolean}) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'image-projection',
    {
      disable: boolean('disable', 'Turn off MCP memory image projection and persist immediately'),
      enable: boolean('enable', 'Turn on MCP memory image projection and persist immediately'),
    },
    run,
  ).pipe(Command.withDescription('Show or persist optional MCP memory image projection'));
}
