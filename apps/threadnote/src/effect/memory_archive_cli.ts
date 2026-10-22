import {Cause, Effect, Option, Schema} from 'effect';
import {Command} from 'effect/cli';
import {SystemInfo} from '@threadnote/platform/system';
import type {RuntimeConfig} from '@threadnote/workspace/config';
import type {CliRuntimeRunner} from './cli.js';
import {writeFinalCliOutput} from './cli/output.js';
import {captureConsole} from './console.js';
import {getInputText} from '../utils.js';
import {
  MemoryArchivePlanError,
  MemoryArchivePlanSchema,
  planMemoryArchive,
  checkMemoryArchivePlan,
  commitMemoryArchive,
} from '../memory/archive_plan.js';

const protocolFailure = (cause: Cause.Cause<unknown>) =>
  Effect.gen(function* () {
    if (Cause.hasInterrupts(cause)) return yield* Effect.failCause(cause);
    const error = Option.getOrUndefined(Cause.findErrorOption(cause));
    (yield* SystemInfo).setExitCode(1);
    return {
      version: 1 as const,
      status: 'error' as const,
      code: Schema.is(MemoryArchivePlanError)(error) ? error.code : 'operation-failed',
      message: Schema.is(MemoryArchivePlanError)(error)
        ? error.message
        : 'The exact archive operation failed; no success is implied.',
    };
  });

const requestSchema = Schema.Union([
  Schema.Struct({version: Schema.Literal(1), action: Schema.Literal('plan'), uri: Schema.String}),
  Schema.Struct({
    version: Schema.Literal(1),
    action: Schema.Literals(['check', 'commit']),
    plan: MemoryArchivePlanSchema,
  }),
]);
export const runMemoryArchiveRequest = Effect.fn('memoryArchive.request')(function* (
  config: RuntimeConfig,
  input: unknown,
) {
  const request = yield* Schema.decodeUnknownEffect(requestSchema)(input, {onExcessProperty: 'error'}).pipe(
    Effect.mapError(() =>
      MemoryArchivePlanError.make({
        code: 'invalid-request',
        message: 'Provide one closed version 1 memory-archive request.',
      }),
    ),
  );
  if (request.action === 'plan')
    return {version: 1 as const, status: 'ok' as const, plan: yield* planMemoryArchive(config, request.uri)};
  return {
    version: 1 as const,
    status: 'ok' as const,
    result: yield* request.action === 'check'
      ? checkMemoryArchivePlan(config, request.plan)
      : commitMemoryArchive(config, request.plan),
  };
});

/** Strict JSON boundary; storeMemory progress stays out of the protocol document. */
export const runMemoryArchiveProtocol = <E, R>(config: RuntimeConfig, input: Effect.Effect<unknown, E, R>) =>
  input.pipe(
    Effect.flatMap(request => captureConsole(runMemoryArchiveRequest(config, request))),
    Effect.map(captured => captured.value),
    Effect.catchCause(protocolFailure),
    Effect.flatMap(result => writeFinalCliOutput(JSON.stringify(result))),
  );

export function makeMemoryArchiveCommand(withRuntime: CliRuntimeRunner) {
  return Command.make('memory-archive', {}, () =>
    withRuntime(config =>
      runMemoryArchiveProtocol(
        config,
        getInputText(undefined, true).pipe(
          Effect.flatMap(text =>
            Effect.try({
              try: () => JSON.parse(text) as unknown,
              catch: () =>
                MemoryArchivePlanError.make({code: 'invalid-request', message: 'Provide one JSON request on stdin.'}),
            }),
          ),
        ),
      ),
    ).pipe(
      Effect.catchCause(cause =>
        protocolFailure(cause).pipe(Effect.flatMap(result => writeFinalCliOutput(JSON.stringify(result)))),
      ),
    ),
  ).pipe(Command.withDescription('Plan, check or commit one exact native personal memory archive'));
}
