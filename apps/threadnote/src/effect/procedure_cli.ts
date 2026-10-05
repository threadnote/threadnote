import type {Effect} from 'effect';
import {Command} from 'effect/cli';
import type {runProcedurePublish, runProcedureStatus, runProcedureVerify} from '../procedure/commands.js';
import {makeProcedurePublishCommand, makeProcedureStatusCommand, makeProcedureVerifyCommand} from './workflow_cli.js';

export function makeProcedureCommand<E1, R1, E2, R2, E3, R3>(
  verify: (options: Parameters<typeof runProcedureVerify>[0]) => Effect.Effect<void, E1, R1>,
  status: (options: Parameters<typeof runProcedureStatus>[0]) => Effect.Effect<void, E2, R2>,
  publish: (options: Parameters<typeof runProcedurePublish>[1]) => Effect.Effect<void, E3, R3>,
) {
  return Command.make('procedure').pipe(
    Command.withDescription('Verify, inspect, and publish reviewed procedures'),
    Command.withSubcommands([
      makeProcedureVerifyCommand(verify),
      makeProcedureStatusCommand(status),
      makeProcedurePublishCommand(publish),
    ]),
  );
}
