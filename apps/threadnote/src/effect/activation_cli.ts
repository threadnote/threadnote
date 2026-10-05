import {Effect} from 'effect';
import {Command} from 'effect/cli';
import {runActivationProductionCommandV1, type ActivationProductionCommandV1} from '../activation/production.js';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import {boolean, optionalString, requiredString} from './cli/flags.js';

const apply = boolean('apply', 'Apply work until the next explicit review boundary');
const approved = boolean('approved', 'Confirm explicit approval of the exact current preview');
const approval = optionalString('approval', 'Exact SHA-256 approval token emitted by the current preview');
const request = requiredString('request', 'Bounded activation request JSON re-observed on every continuation');

export function makeActivationCommand(
  withRuntime: <E, R>(body: (config: RuntimeConfig) => Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>,
) {
  const run = (command: ActivationProductionCommandV1) =>
    withRuntime(config => runActivationProductionCommandV1(config, command));
  const start = Command.make('start', {apply, request}, ({apply, request}) =>
    run({apply, approved: false, command: 'start', requestFile: request}),
  ).pipe(Command.withDescription('Preview or begin a bounded two-surface activation request'));
  const continue_ = Command.make(
    'continue',
    {
      activationId: requiredString('activation-id', 'Exact activation ID returned by activate start'),
      apply,
      approval,
      approved,
      request,
    },
    ({activationId, apply, approval, approved, request}) =>
      run({activationId, apply, approval, approved, command: 'continue', requestFile: request}),
  ).pipe(Command.withDescription('Re-observe live inputs and resume to the next review boundary'));
  const status = Command.make(
    'status',
    {activationId: requiredString('activation-id', 'Exact activation ID returned by activate start')},
    ({activationId}) => run({activationId, apply: false, approved: false, command: 'status'}),
  ).pipe(Command.withDescription('Show content-free activation receipt state and the next operation'));
  const undo = Command.make(
    'undo',
    {
      activationId: requiredString('activation-id', 'Exact activation ID returned by activate start'),
      apply,
      approval,
      approved,
      request,
    },
    ({activationId, apply, approval, approved, request}) =>
      run({activationId, apply, approval, approved, command: 'undo', requestFile: request}),
  ).pipe(Command.withDescription('Preview or apply receipt-owned local activation cleanup'));
  return Command.make('activate').pipe(
    Command.withDescription('Preview and resume a two-surface local guided activation'),
    Command.withSubcommands([start, continue_, status, undo]),
  );
}
