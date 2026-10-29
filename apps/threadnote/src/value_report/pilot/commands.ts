import {Console, Effect, Schema} from 'effect';
import {writeFinalCliOutput} from '../../effect/cli/output.js';
import {readOperatorJson} from '@threadnote/remote-memory/operator/files';
import {SystemInfo} from '@threadnote/platform/system';
import {expandPath} from '@threadnote/platform/paths';
import {buildPilotReport, serializePilotReport} from '../pilot.js';
import {exportPilotReport, managePilotReports} from './storage.js';

export class PilotCommandError extends Schema.TaggedError<PilotCommandError, {readonly brand: unique symbol}>()(
  'PilotCommandError',
  {
    message: Schema.String,
  },
) {}

export interface PilotCommandOptions {
  readonly action: 'report' | 'export' | 'retention' | 'reset';
  readonly input?: string;
  readonly apply?: boolean;
  readonly selectionDigest?: string;
}

export const runPilotCommand = Effect.fn('valueReport.pilot.command')(function* (
  config: {readonly agentContextHome: string},
  options: PilotCommandOptions,
) {
  yield* Effect.gen(function* () {
    if (options.action === 'retention' || options.action === 'reset') {
      if (options.input !== undefined)
        return yield* PilotCommandError.make({message: 'Input is not accepted for storage operations.'});
      const receipt = yield* managePilotReports(
        config.agentContextHome,
        options.action,
        options.apply === true,
        options.selectionDigest,
      );
      yield* writeFinalCliOutput(JSON.stringify(receipt));
      return;
    }
    if (options.selectionDigest !== undefined)
      return yield* PilotCommandError.make({message: 'Selection digest is only accepted for reset.'});
    if (options.input === undefined || (options.action === 'report' && options.apply === true)) {
      return yield* PilotCommandError.make({message: 'Report requires input and does not accept apply.'});
    }
    const raw = yield* readOperatorJson(options.input);
    const report = yield* Effect.try(() => buildPilotReport(raw));
    if (options.action === 'export' && options.apply === true) {
      const receipt = yield* exportPilotReport(config.agentContextHome, report, true);
      yield* writeFinalCliOutput(JSON.stringify(receipt));
      return;
    }
    const serialized = yield* Effect.try(() => serializePilotReport(report));
    yield* writeFinalCliOutput(serialized);
  }).pipe(
    Effect.catchCause(() =>
      PilotCommandError.make({message: 'Pilot command failed: invalid input or unavailable local storage.'}),
    ),
  );
});

export const withPilotHome = <A, E, R>(
  home: string | undefined,
  operation: (config: {readonly agentContextHome: string}) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const system = yield* SystemInfo;
    const agentContextHome = yield* expandPath(home ?? system.environment().THREADNOTE_HOME ?? '~/.threadnote');
    return yield* operation({agentContextHome});
  }).pipe(
    Effect.catchCause(() =>
      PilotCommandError.make({message: 'Pilot command failed: invalid input or unavailable local storage.'}),
    ),
  );

export const withPilotDiagnostics = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Console.consoleWith(parent =>
    effect.pipe(
      Effect.provideService(Console.Console, {
        ...parent,
        error: () => parent.error('Pilot command failed: invalid input or unavailable local storage.'),
        warn: () => parent.warn('Pilot command failed: invalid input or unavailable local storage.'),
      }),
    ),
  );
