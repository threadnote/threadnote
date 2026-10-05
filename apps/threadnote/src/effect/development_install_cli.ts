import {Command} from 'effect/cli';
import type {Effect} from 'effect';
import {boolean, requiredString} from './cli/flags.js';

export function makeDevelopmentInstallRepairCommand<E, R>(
  run: (options: {
    readonly activateIntegrations: boolean;
    readonly expectedVersion: string;
  }) => Effect.Effect<void, E, R>,
) {
  return Command.make(
    'development-install-repair',
    {
      activateIntegrations: boolean('activate-integrations', 'Activate registered agent integration artifacts'),
      expectedVersion: requiredString('expected-version', 'Exact active development release version'),
    },
    run,
  ).pipe(Command.withDescription('Repair state inside an exact-HEAD development activation'), Command.unlisted);
}
